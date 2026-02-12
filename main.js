import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import {
  getFirestore, collection, addDoc, serverTimestamp,
  query, where, onSnapshot, getDocs
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";

(() => {
  // =============================
  // ===== 운영자 설정(여기만 수정) =====
  // =============================
  const DEFAULT_DIFFICULTY = 5;      // 1~5  (타겟 이동 속도)
  const DEFAULT_SENSITIVITY = 2;   // 내부 계산용(현재 고정)
  const COUPON_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2시간
  const TARGET_HIT_RADIUS = 18;      // ✅ 히트박스 반경(px). PNG 크기와 분리(추천)
  const IRREGULAR_SPEED_MIN = 0.6;   // 불규칙 속도 최소 배율
  const IRREGULAR_SPEED_MAX = 1.1;   // 불규칙 속도 최대 배율
  const USE_TARGET_IMAGE = true;     // PNG 사용할지 여부
  const BUILD_VERSION = "5콤보시 쿠폰 증정!_1909"; // 배포 확인용 버전(코드 수정 시 올리기)

  // ===== 타겟(몬스터) 정의 =====
  const TARGET_DEFS = [
    { src: "target.png",  name: "피카츄",   weight: 32 },
    { src: "target2.png", name: "파이리",   weight: 32 },
    { src: "target3.png", name: "이상해씨",   weight: 32 },
    { src: "target4.png", name: "뮤츠", weight: 3  },
    { src: "target5.png", name: "뮤", weight: 1  },
  ];
  const CATCH_COMBO_THRESHOLD = 3; // 이 콤보 달성 시 타겟 포획
  // =============================

  const firebaseConfig = {
    apiKey: "AIzaSyDwXIjBRO-S8MLXS_mScveA845pUKY9fCA",
    authDomain: "tape-seoul-catch.firebaseapp.com",
    projectId: "tape-seoul-catch",
    storageBucket: "tape-seoul-catch.firebasestorage.app",
    messagingSenderId: "985851999683",
    appId: "1:985851999683:web:a0634a1a7641d5c2f5b976",
    measurementId: "G-ZSH3PSRRB3"
  };

  let db = null;
  let firebaseReady = false;
  try {
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    firebaseReady = true;
  } catch (err) {
    console.error("[Firebase] 초기화 실패", err);
  }

  // =====================
  // 48시간 리더보드 버킷 설정
  // =====================
  const BUCKET_MS = 48 * 60 * 60 * 1000;

  // 🔴 여기 날짜를 게임 오픈일 00:00 (한국시간)으로 설정하세요
  // 예: 2026년 2월 12일 오픈이면 아래 그대로 사용
  const RESET_ANCHOR_KST = "2026-02-12T00:00:00+09:00";
  
  function currentBucketId() {
    const anchor = new Date(RESET_ANCHOR_KST).getTime();
    const now = Date.now();
    return Math.floor((now - anchor) / BUCKET_MS);
}



  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // Audio (항상 ON)
  let audioCtx = null;
  function beep(freq = 880, dur = 0.06, gain = 0.06) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      g.gain.value = gain;
      o.connect(g);
      g.connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + dur);
    } catch (_) {}
  }

  // Canvas
  const cv = $("cv");
  const ctx = cv.getContext("2d");
  const world = { w: 0, h: 0 };

  function resize() {
    const rect = cv.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    cv.width = Math.floor(rect.width * dpr);
    cv.height = Math.floor(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    world.w = rect.width;
    world.h = rect.height;
  }
  window.addEventListener("resize", resize);

  // Target images (preload all)
  const targetImages = {};
  let currentTargetDef = TARGET_DEFS[0]; // 현재 활성 타겟
  if (USE_TARGET_IMAGE) {
    for (const def of TARGET_DEFS) {
      const img = new Image();
      img.onload = () => { img._ready = true; };
      img.src = def.src;
      targetImages[def.src] = img;
    }
  }

  function pickRandomTarget(excludeSrc) {
    // 가중치 기반 랜덤 선택 (현재 타겟 제외 가능)
    const pool = excludeSrc
      ? TARGET_DEFS.filter(d => d.src !== excludeSrc)
      : TARGET_DEFS;
    const totalWeight = pool.reduce((s, d) => s + d.weight, 0);
    let r = Math.random() * totalWeight;
    for (const d of pool) {
      r -= d.weight;
      if (r <= 0) return d;
    }
    return pool[pool.length - 1];
  }

  // Game state
  const state = {
    running: false,

    // option (only)
    optMotionThrow: false,

    score: 0,
    combo: 0,
    maxCombo: 0,
    best: 0,

    difficulty: DEFAULT_DIFFICULTY,
    sensitivity: DEFAULT_SENSITIVITY,

    // Tap-hold charge
    holding: false,
    holdStartAt: 0,
    chargePower: 0, // 0..1

    // throw cooldown
    lastThrowAt: 0,

    // motion
    lastAccelZ: 0,
    motionArmed: false,

    // coupon
    lastCouponAt: 0,

    // catch collection
    caughtSet: new Set(), // 잡은 타겟 이름들
  };

  // 포획 메시지
  const catchMsg = {
    text: "",
    until: 0,
  };

  const target = {
    x: 0,
    y: 0,
    dir: 1,
    vx: 0,
    hitR: TARGET_HIT_RADIUS,
    prevX: 0,

    // image draw size (보이는 크기) - PNG 크기와 무관하게 여기서 스케일 조절 가능
    drawW: 64,
    drawH: 64,
  };

  const ball = {
    active: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    bestDist: Infinity,
  };

  const feedback = {
    text: "",
    color: "rgba(234,240,255,0.95)",
    until: 0,
    scale: 1,
  };

  // Combo hit particles
  const particles = [];
  function spawnComboParticles(x, y, combo) {
    const count = Math.min(12, 4 + combo * 2);
    const colors = [
      "rgba(168,255,110,0.9)", "rgba(110,231,255,0.9)",
      "rgba(255,215,0,0.9)", "rgba(200,160,255,0.9)",
    ];
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
      const speed = 80 + Math.random() * 120 + combo * 15;
      particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.5 + Math.random() * 0.3,
        maxLife: 0.5 + Math.random() * 0.3,
        r: 2 + Math.random() * 3,
        color: colors[i % colors.length],
      });
    }
  }
  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 200 * dt; // light gravity
      p.life -= dt;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }
  function drawParticles() {
    for (const p of particles) {
      const alpha = clamp(p.life / p.maxLife, 0, 1);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * alpha, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // Screen shake
  let shakeUntil = 0;
  let shakeIntensity = 0;

  function difficultySpeed(diff) {
    // 1..5
    return 220 + (diff - 1) * 90;
  }

  // 콤보 기반 속도 보정
  let irregularTimer = 0;
  let irregularSpeedMul = 1;

  function comboSpeedMultiplier(combo) {
    // combo 0: 1.0x, combo 1: 1.25x, combo 2+: 1.40x (cap)
    if (combo <= 0) return 1.0;
    if (combo === 1) return 1.25;
    return 1.40; // combo 2+ 에서 고정 (더 이상 난이도 증가 없음)
  }

  // Combo visual styling
  let prevComboForAnim = 0;
  function comboClass(c) {
    if (c <= 0) return "";
    if (c === 1) return "combo-1";
    if (c === 2) return "combo-2";
    if (c === 3) return "combo-3";
    return "combo-max";
  }

  // UI sync
  function syncUI() {
    $("score").textContent = String(state.score);
    $("combo").textContent = String(state.combo);
    $("maxCombo").textContent = String(state.maxCombo);
    $("best").textContent = String(state.best);

    // Combo pill styling
    const pill = $("comboPill");
    pill.className = "pill";
    const cls = comboClass(state.combo);
    if (cls) pill.classList.add(cls);

    // Pop animation on combo increase
    if (state.combo > prevComboForAnim) {
      pill.classList.remove("combo-pop");
      // Force reflow to restart animation
      void pill.offsetWidth;
      pill.classList.add("combo-pop");
    }
    prevComboForAnim = state.combo;
  }

  function loadLocal() {
    try {
      const best = Number(localStorage.getItem("tapemongo_best") || "0");
      state.best = isFinite(best) ? best : 0;

      const lastCouponAt = Number(localStorage.getItem("tapemongo_coupon_at") || "0");
      state.lastCouponAt = isFinite(lastCouponAt) ? lastCouponAt : 0;
    } catch (_) {}
  }

  function saveBest() {
    try { localStorage.setItem("tapemongo_best", String(state.best)); } catch (_) {}
  }
  function saveCouponAt() {
    try { localStorage.setItem("tapemongo_coupon_at", String(state.lastCouponAt)); } catch (_) {}
  }

  // Leaderboard (local for now)
  const todayKey = () => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}${m}${dd}`;
  };
  function lbKey(){ return `tapemongo_lb_${todayKey()}`; }
  function getLB() {
    try {
      const raw = localStorage.getItem(lbKey());
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }
  function setLB(arr) {
    try { localStorage.setItem(lbKey(), JSON.stringify(arr)); } catch (_) {}
  }
  function escapeHtml(s) {
    return String(s)
      .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
      .replaceAll('"',"&quot;").replaceAll("'","&#039;");
  }
  function renderLB() {
    const list = $("lbList");
    const lb = getLB().sort((a,b)=> (b.score||0)-(a.score||0)).slice(0,10);
    if (lb.length === 0) {
      list.innerHTML = `<div class="lbRow"><span>아직 기록이 없어요</span><span>—</span></div>`;
      return;
    }
    list.innerHTML = lb.map((e,i)=>{
      const name = (e.name||"NONAME").slice(0,15);
      const sc = e.score||0;
      return `<div class="lbRow"><span>#${i+1} ${escapeHtml(name)}</span><span class="mono">${sc}</span></div>`;
    }).join("");
  }
  function renderServerRows(rows) {
    const list = $("lbList");
    // 헤더
    const header = `<div class="lbRow lbHeader"><span>ID</span><span class="mono">수집</span><span class="mono">점수</span><span class="mono">콤보</span></div>`;
    if (!rows.length) {
      list.innerHTML = header + `<div class="lbRow"><span>아직 기록이 없어요</span><span>—</span><span>—</span><span>—</span></div>`;
      return;
    }

    list.innerHTML = header + rows.map((d, idx) => {
      const safeName = escapeHtml((d.name || "NONAME").slice(0, 15));
      const score = Number(d.score) || 0;
      const monsters = Number(d.monsters) || 0;
      const maxCombo = Number(d.maxCombo) || 0;
      return `<div class="lbRow"><span>#${idx + 1} ${safeName}</span><span class="mono">${monsters}</span><span class="mono">${score}</span><span class="mono">${maxCombo}</span></div>`;
    }).join("");
  }

  function listenTop10() {
    const list = $("lbList");
    if (!firebaseReady || !db) {
      list.innerHTML = `<div class="lbRow"><span>서버 연결 실패</span><span>Firebase 설정 확인</span></div>`;
      return () => {};
    }

    const bucketId = currentBucketId();
    const q = query(collection(db, "scores"), where("bucketId", "==", bucketId));

    return onSnapshot(q, (qs) => {
      const rows = [];
      qs.forEach((doc) => rows.push(doc.data()));

      rows.sort((a, b) => {
        // 콤보 > 수집 > 점수 순으로 랭킹
        const byCombo = (Number(b.maxCombo) || 0) - (Number(a.maxCombo) || 0);
        if (byCombo !== 0) return byCombo;
        const byMonsters = (Number(b.monsters) || 0) - (Number(a.monsters) || 0);
        if (byMonsters !== 0) return byMonsters;
        const byScore = (Number(b.score) || 0) - (Number(a.score) || 0);
        if (byScore !== 0) return byScore;
        const at = (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0);
        return at;
      });

      renderServerRows(rows.slice(0, 10));
    }, (err) => {
      console.error("[Firebase] 리더보드 구독 실패", err);
      const code = err?.code || "";
      const hint = code === "permission-denied" ? "Firestore 규칙 확인" : "네트워크/설정 확인";
      list.innerHTML = `<div class="lbRow"><span>리더보드 불러오기 실패</span><span>${hint}</span></div>`;
    });
  }

  // Coupon modal (persistent)
  function showCouponModal(code, timeText) {
    $("couponCode").textContent = code;
    $("couponTime").textContent = timeText;
    $("couponModal").classList.remove("hidden");
  }
  function hideCouponModal() {
    $("couponModal").classList.add("hidden");
  }
  function makeCouponCode(now) {
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let s = "TAPE-";
    for (let i=0;i<4;i++) s += chars[Math.floor(Math.random()*chars.length)];
    // 시간 포함(표시용)
    const hh = String(now.getHours()).padStart(2,"0");
    const mm = String(now.getMinutes()).padStart(2,"0");
    return `${s}-${hh}${mm}`;
  }
  function formatTime(now) {
    const y = now.getFullYear();
    const mo = String(now.getMonth()+1).padStart(2,"0");
    const d = String(now.getDate()).padStart(2,"0");
    const hh = String(now.getHours()).padStart(2,"0");
    const mm = String(now.getMinutes()).padStart(2,"0");
    return `${y}-${mo}-${d} ${hh}:${mm}`;
  }
  // 축하 연출 상태
  const celebration = { active: false, until: 0, triggered: false };

  function maybeCatchTarget() {
    if (state.combo < CATCH_COMBO_THRESHOLD) return;
    if (state.combo % CATCH_COMBO_THRESHOLD !== 0) return;

    const name = currentTargetDef.name;
    state.caughtSet.add(name);

    // 모두 잡았는지 체크 (최초 1회만 축하 연출)
    if (state.caughtSet.size >= TARGET_DEFS.length && !celebration.triggered) {
      celebration.triggered = true;
      catchMsg.text = "몬스터를 모두 잡았다!";
      catchMsg.until = performance.now() + 4000;
      celebration.active = true;
      celebration.until = performance.now() + 4000;
      // 대량 파티클 발사
      for (let i = 0; i < 5; i++) {
        const cx = world.w * (0.2 + Math.random() * 0.6);
        const cy = world.h * (0.2 + Math.random() * 0.4);
        spawnComboParticles(cx, cy, 10);
      }
      beep(1500, 0.12, 0.1);
      setTimeout(() => beep(1800, 0.12, 0.1), 150);
      setTimeout(() => beep(2200, 0.15, 0.1), 300);
    } else if (state.caughtSet.size < TARGET_DEFS.length) {
      // 포획 메시지 표시
      catchMsg.text = `${name}을(를) 잡았다!`;
      catchMsg.until = performance.now() + 2000;
    }

    // 다른 타겟으로 교체
    const newDef = pickRandomTarget(currentTargetDef.src);
    currentTargetDef = newDef;

    syncCatchUI();
  }

  function syncCatchUI() {
    const el = $("catchCount");
    if (el) el.textContent = `수집 ${state.caughtSet.size}/${TARGET_DEFS.length}`;
  }

  function maybeShowCouponOnCombo3() {
    // 5연속 콤보일때만 (5,10,15... 도 "5연속" 달성으로 보고 발급)
    if (state.combo < 5) return;
    if (state.combo % 5 !== 0) return;

    const nowMs = Date.now();
    if (nowMs - state.lastCouponAt < COUPON_COOLDOWN_MS) return;

    const now = new Date();
    const code = makeCouponCode(now);
    const timeText = `Time: ${formatTime(now)}`;

    state.lastCouponAt = nowMs;
    saveCouponAt();

    showCouponModal(code, timeText);
    beep(1200, 0.07, 0.08);
  }

  // Motion permission (optional)
  async function ensureMotionPermissionIfNeeded() {
    if (!state.optMotionThrow) return true;
    try {
      const DME = window.DeviceMotionEvent;
      if (!DME) return false;
      if (typeof DME.requestPermission === "function") {
        const res = await DME.requestPermission();
        return res === "granted";
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function onDeviceMotion(e) {
    if (!state.running || !state.optMotionThrow) return;
    const acc = e.accelerationIncludingGravity;
    if (!acc) return;

    const z = acc.z || 0;
    const dz = z - state.lastAccelZ;
    state.lastAccelZ = z;

    // hold 중이면 "던질 준비"
    if (state.holding && state.chargePower > 0.15) state.motionArmed = true;

    const thresh = 6.0 * state.sensitivity;
    if (state.motionArmed && dz < -thresh) {
      // 모션 던지기: 중앙으로 던짐
      launchBall(state.chargePower, world.w * 0.5);
      endHold();
      state.motionArmed = false;
    }
  }

  // Gameplay
  function startGame() {
    state.running = true;
    // target initial
    target.y = world.h * 0.30;
    target.x = world.w * 0.5;
    target.prevX = target.x;
    target.vx = difficultySpeed(state.difficulty);
    beep(990, 0.06, 0.06);
  }

  function updateTarget(dt) {
    target.prevX = target.x;

    const baseSpeed = difficultySpeed(state.difficulty);
    const comboMul = comboSpeedMultiplier(state.combo);
    let speed = baseSpeed * comboMul;

    // combo 2+: 불규칙적 속도 변화 + 갑작스러운 방향 전환
    if (state.combo >= 2) {
      irregularTimer += dt;
      // 주기적으로 속도 배율 변경 (0.5~1.8초 간격)
      const interval = Math.max(0.5, 1.8 - state.combo * 0.12);
      if (irregularTimer >= interval) {
        irregularTimer = 0;
        // 운영자 설정에 따른 랜덤 속도 배율
        irregularSpeedMul = IRREGULAR_SPEED_MIN + Math.random() * (IRREGULAR_SPEED_MAX - IRREGULAR_SPEED_MIN);
      }
      speed *= irregularSpeedMul;

      // combo 2+: 가끔 갑자기 방향 전환
      if (Math.random() < 0.012) {
        target.dir *= -1;
      }
    } else {
      irregularSpeedMul = 1;
      irregularTimer = 0;
    }

    target.vx = speed;
    target.x += target.dir * target.vx * dt;

    const margin = 24;
    if (target.x < margin) { target.x = margin; target.dir = 1; }
    if (target.x > world.w - margin) { target.x = world.w - margin; target.dir = -1; }
  }

  function launchBall(power, aimX) {
    const now = performance.now();
    if (now - state.lastThrowAt < 250) return;
    state.lastThrowAt = now;

    const p = clamp(power, 0.08, 1.0);

    ball.active = true;
    ball.x = world.w * 0.5;
    ball.y = world.h * 0.88;

    const dx = (aimX - ball.x);
    const maxDx = world.w * 0.45;
    const nx = clamp(dx / maxDx, -1, 1);

    // Scale velocity based on screen height so the ball can always reach the target
    // Reference height ~400px (iPhone 15 canvas). On taller screens, scale up.
    const refH = 400;
    const hScale = Math.sqrt(Math.max(1, world.h / refH));

    ball.vx = nx * (420 * hScale * p);
    ball.vy = -(760 * hScale * (0.50 + 0.60 * p));
    ball.bestDist = Infinity;

    beep(880 + 280 * p, 0.05, 0.06);
  }

  function minDistanceInFrame(prevX, prevY) {
    const rel0x = prevX - target.prevX;
    const rel0y = prevY - target.y;
    const rel1x = ball.x - target.x;
    const rel1y = ball.y - target.y;

    const dRelX = rel1x - rel0x;
    const dRelY = rel1y - rel0y;
    const denom = dRelX * dRelX + dRelY * dRelY;

    let t = 0;
    if (denom > 0) {
      t = clamp(-(rel0x * dRelX + rel0y * dRelY) / denom, 0, 1);
    }

    const closestRelX = rel0x + dRelX * t;
    const closestRelY = rel0y + dRelY * t;
    const dist = Math.hypot(closestRelX, closestRelY);

    return { dist, t };
  }

  function showJudgeFeedback(label) {
    const now = performance.now();

    // Dynamic colors based on combo level
    let perfectColor = "rgba(168,255,110,0.98)";
    if (state.combo >= 4) perfectColor = "rgba(255,215,0,0.98)";
    else if (state.combo >= 3) perfectColor = "rgba(255,215,0,0.98)";
    else if (state.combo >= 2) perfectColor = "rgba(200,160,255,0.98)";

    let niceColor = "rgba(110,231,255,0.98)";
    if (state.combo >= 3) niceColor = "rgba(255,215,0,0.90)";
    else if (state.combo >= 2) niceColor = "rgba(200,160,255,0.90)";

    const styleByLabel = {
      "PERFECT": { color: perfectColor, scale: 1.1 + Math.min(0.3, state.combo * 0.05) },
      "NICE": { color: niceColor, scale: 1.0 + Math.min(0.2, state.combo * 0.04) },
      "MISS😣": { color: "rgba(255,166,166,0.98)", scale: 0.95 },
    };
    const style = styleByLabel[label] || { color: "rgba(234,240,255,0.98)", scale: 1.0 };

    // Include combo count in feedback for combos >= 2
    let displayText = label;
    if (!label.startsWith("MISS") && state.combo >= 2) {
      displayText = `${label} x${state.combo}`;
    }

    feedback.text = displayText;
    feedback.color = style.color;
    feedback.scale = style.scale;
    feedback.until = now + 820;
  }

  function judgeLabelByDistance(dist) {
    const perfect = target.hitR * 0.6;  // ~10.8px (기존 0.45=8.1px → 더 넓은 PERFECT 존)
    const nice = target.hitR;
    const nearMiss = target.hitR * 1.45;

    if (dist <= perfect) return { label: "PERFECT", add: 300 };
    if (dist <= nice) return { label: "NICE", add: 120 };
    if (dist <= nearMiss) return { label: "MISS😣", add: 0 };
    return { label: "MISS😣", add: 0 };
  }

  function finishThrowByDistance(dist) {
    const { label, add } = judgeLabelByDistance(dist);

    if (label.startsWith("MISS")) {
      state.combo = 0;
      showJudgeFeedback(label);
      beep(220, 0.08, 0.06);

      // miss 시 타겟 변경
      const newDef = pickRandomTarget(currentTargetDef.src);
      currentTargetDef = newDef;

      syncUI();
      return;
    }

    // 콤보를 먼저 증가시킨 후 피드백 표시 (숫자 일치)
    state.combo += 1;
    if (state.combo > state.maxCombo) state.maxCombo = state.combo;
    showJudgeFeedback(label);

    const comboMul = 1 + Math.min(0.6, state.combo * 0.06);
    const gained = Math.round(add * comboMul);

    state.score += gained;
    if (state.score > state.best) { state.best = state.score; saveBest(); }

    // Combo visual effects
    if (state.combo >= 2) {
      spawnComboParticles(target.x, target.y, state.combo);
      shakeIntensity = Math.min(4, 1 + state.combo * 0.5);
      shakeUntil = performance.now() + 200;
    }

    if (label === "PERFECT") beep(1200, 0.06, 0.08);
    else beep(820, 0.06, 0.06);

    // 콤보 달성 시 타겟 포획 체크
    maybeCatchTarget();
    maybeShowCouponOnCombo3();
    syncUI();
  }

  function updateBall(dt) {
    if (!ball.active) return;

    const prevX = ball.x;
    const prevY = ball.y;

    const g = 1450;
    ball.vy += g * dt;

    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // 판정: 프레임 사이에서 공과 움직이는 히트박스가 닿기만 해도 성공
    const { dist } = minDistanceInFrame(prevX, prevY);
    ball.bestDist = Math.min(ball.bestDist, dist);
    if (dist <= target.hitR) {
      ball.active = false;
      finishThrowByDistance(dist);
      return;
    }

    if (ball.y > world.h + 60 || ball.x < -60 || ball.x > world.w + 60) {
      ball.active = false;
      finishThrowByDistance(ball.bestDist);
    }
  }

  // Tap-hold charge
  function beginHold(pointX) {
    if (!state.running) return;
    state.holding = true;
    state.holdStartAt = performance.now();
    state.chargePower = 0;
    state.motionArmed = false;

    // 누르고 있는 동안 "조준" 위치를 갱신하려면 여기서 저장해도 됨(현재는 release 시 위치 사용)
  }

  function updateHold() {
    if (!state.holding) return;
    const now = performance.now();
    const heldMs = now - state.holdStartAt;

    // 0.9초에 풀차지 (원하시면 운영자 설정으로 빼드릴 수도 있어요)
    const fullMs = 900;
    state.chargePower = clamp(heldMs / fullMs, 0, 1);
  }

  function endHold() {
    state.holding = false;
    state.holdStartAt = 0;
    state.chargePower = 0;
    state.motionArmed = false;
  }

  // Input (tap hold / release)
  function getPoint(e) {
    const rect = cv.getBoundingClientRect();
  
    // ✅ touchend/touchcancel 에서는 touches가 비어있고 changedTouches에 있음
    const t =
      (e.touches && e.touches[0]) ||
      (e.changedTouches && e.changedTouches[0]) ||
      null;
  
    const clientX = t ? t.clientX : e.clientX;
    const clientY = t ? t.clientY : e.clientY;
  
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return { x, y };
  }


  function onPointerDown(e) {
    if (!state.running) return;
    const p = getPoint(e);
    beginHold(p.x);
    e.preventDefault?.();
  }

  function onPointerMove(e) {
    // (원하면 드래그 조준 가능. 지금은 release 위치로만 조준)
    e.preventDefault?.();
  }

  function onPointerUp(e) {
    if (!state.running) return;
    if (!state.holding) return;
  
    const p = getPoint(e);
    const power = clamp(state.chargePower, 0.08, 1.0);
  
    // ✅ 먼저 hold 상태부터 무조건 해제 (stuck 방지)
    endHold();
  
    // 던지기
    launchBall(power, p.x);
  
    e.preventDefault?.();
  }

  let activeTouchId = null;

  function onTouchStart(e) {
    if (!state.running) return;
    if (activeTouchId !== null) return;

    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;

    activeTouchId = t.identifier;
    onPointerDown(e);
  }

  function onTouchMove(e) {
    if (activeTouchId === null) return;
    const touch = Array.from(e.touches || []).find((t) => t.identifier === activeTouchId);
    if (!touch) return;
    onPointerMove(e);
  }

  function onTouchEndOrCancel(e) {
    if (activeTouchId === null) return;
    const touch = Array.from(e.changedTouches || []).find((t) => t.identifier === activeTouchId);
    if (!touch) return;

    onPointerUp(e);
    activeTouchId = null;
  }


  // Render
  function drawBackground() {
    const w = world.w, h = world.h;
    ctx.clearRect(0, 0, w, h);

    const g = ctx.createRadialGradient(w*0.5, h*0.1, 20, w*0.5, h*0.5, Math.max(w,h));
    g.addColorStop(0, "rgba(110,231,255,0.12)");
    g.addColorStop(0.55, "rgba(255,255,255,0.00)");
    g.addColorStop(1, "rgba(0,0,0,0.25)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w*0.08, h*0.88);
    ctx.lineTo(w*0.92, h*0.88);
    ctx.stroke();
  }

  function drawTarget() {
    ctx.save();
    ctx.translate(target.x, target.y);

    // glow
    ctx.beginPath();
    ctx.fillStyle = "rgba(110,231,255,0.18)";
    ctx.arc(0, 0, target.hitR * 1.9, 0, Math.PI * 2);
    ctx.fill();

    const curImg = targetImages[currentTargetDef.src];
    if (USE_TARGET_IMAGE && curImg && curImg._ready) {
      // 이미지 중심 기준으로 그리기
      const w = target.drawW;
      const h = target.drawH;
      ctx.drawImage(curImg, -w/2, -h/2, w, h);
    } else {
      // fallback (원형)
      ctx.beginPath();
      ctx.fillStyle = "rgba(234,240,255,0.9)";
      ctx.arc(0, 0, 18, 0, Math.PI * 2);
      ctx.fill();
    }

    // 히트박스 시각화 (육안 판정 기준) - combo에 따라 색상 변경
    ctx.beginPath();
    let hitColor = "rgba(110,231,255,0.85)";
    if (state.combo >= 4) hitColor = "rgba(255,215,0,0.90)";
    else if (state.combo >= 3) hitColor = "rgba(255,215,0,0.85)";
    else if (state.combo >= 2) hitColor = "rgba(200,160,255,0.85)";
    else if (state.combo >= 1) hitColor = "rgba(110,231,255,0.85)";
    ctx.strokeStyle = hitColor;
    ctx.lineWidth = 2;
    ctx.arc(0, 0, target.hitR, 0, Math.PI * 2);
    ctx.stroke();

    // Combo glow ring
    if (state.combo >= 2) {
      const pulseT = (performance.now() % 800) / 800;
      const pulseAlpha = 0.15 + Math.sin(pulseT * Math.PI * 2) * 0.1;
      ctx.beginPath();
      ctx.strokeStyle = hitColor.replace(/[\d.]+\)$/, pulseAlpha + ")");
      ctx.lineWidth = 3;
      ctx.arc(0, 0, target.hitR * (1.6 + pulseT * 0.3), 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawBall() {
    // launcher & charge bar
    const baseX = world.w * 0.5;
    const baseY = world.h * 0.88;

    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.beginPath();
    ctx.roundRect(baseX - 56, baseY + 14, 112, 10, 6);
    ctx.fill();

    const p = clamp(state.chargePower, 0, 1);
    ctx.fillStyle = `rgba(168,255,110,${0.15 + 0.35*p})`;
    ctx.beginPath();
    ctx.roundRect(baseX - 56, baseY + 14, 112 * p, 10, 6);
    ctx.fill();
    ctx.restore();

    if (!ball.active) return;

    ctx.save();
    ctx.translate(ball.x, ball.y);

    // trail
    ctx.strokeStyle = "rgba(110,231,255,0.30)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-ball.vx * 0.03, -ball.vy * 0.03);
    ctx.lineTo(0, 0);
    ctx.stroke();

    // capsule
    ctx.fillStyle = "rgba(110,231,255,0.25)";
    ctx.beginPath();
    ctx.arc(0, 0, 14, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(234,240,255,0.92)";
    ctx.beginPath();
    ctx.arc(0, 0, 10, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function drawHUDText() {
    ctx.save();
    ctx.fillStyle = "rgba(234,240,255,0.78)";
    ctx.font = "14px ui-sans-serif, system-ui, -apple-system, Apple SD Gothic Neo, Noto Sans KR, sans-serif";

    if (!state.running) {
      ctx.fillText("플레이 시작을 누르세요", 18, 28);
      ctx.restore();
      return;
    }

    if (state.holding) {
      ctx.fillText(`CHARGE ${Math.round(state.chargePower * 100)}%`, 18, 28);
    } else {
      ctx.textAlign = "center";
      ctx.fillText(`야생의 ${currentTargetDef.name}이(가) 나타났다!`, world.w * 0.5, 28);
      ctx.fillText(BUILD_VERSION, world.w * 0.5, 50);
      ctx.textAlign = "start";
    }

    // 축하 연출 배경
    if (celebration.active && performance.now() < celebration.until) {
      const remain = clamp((celebration.until - performance.now()) / 4000, 0, 1);
      ctx.save();
      ctx.globalAlpha = remain * 0.25;
      ctx.fillStyle = "rgba(255,215,0,1)";
      ctx.fillRect(0, 0, world.w, world.h);
      ctx.restore();
    } else if (celebration.active) {
      celebration.active = false;
    }

    // 포획 메시지
    if (catchMsg.text && performance.now() < catchMsg.until) {
      const duration = celebration.active ? 4000 : 2000;
      const remain = clamp((catchMsg.until - performance.now()) / duration, 0, 1);
      ctx.save();
      ctx.globalAlpha = 0.4 + remain * 0.6;
      ctx.fillStyle = "rgba(255,215,0,0.98)";
      const fontSize = celebration.active ? 28 : 22;
      ctx.font = `bold ${fontSize}px ui-sans-serif, system-ui, -apple-system, Apple SD Gothic Neo, Noto Sans KR, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(catchMsg.text, world.w * 0.5, world.h * 0.45);
      ctx.textAlign = "start";
      ctx.restore();
    }

    if (feedback.text && performance.now() < feedback.until) {
      const remain = clamp((feedback.until - performance.now()) / 820, 0, 1);
      ctx.globalAlpha = 0.35 + remain * 0.65;
      ctx.fillStyle = feedback.color;
      ctx.font = `${Math.round(26 * feedback.scale)}px ui-sans-serif, system-ui, -apple-system, Apple SD Gothic Neo, Noto Sans KR, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(feedback.text, world.w * 0.5, world.h * 0.16);
      ctx.textAlign = "start";
    }

    ctx.restore();
  }

  // Loop
  let last = performance.now();
  function tick(now) {
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;

    if (state.running) {
      updateHold();
      updateTarget(dt);
      updateBall(dt);
      updateParticles(dt);
    }

    // Screen shake
    const shaking = performance.now() < shakeUntil;
    if (shaking) {
      const sx = (Math.random() - 0.5) * shakeIntensity * 2;
      const sy = (Math.random() - 0.5) * shakeIntensity * 2;
      ctx.save();
      ctx.translate(sx, sy);
    }

    drawBackground();
    drawTarget();
    drawBall();
    drawParticles();
    drawHUDText();

    if (shaking) {
      ctx.restore();
    }

    requestAnimationFrame(tick);
  }

  // Events
  // Pointer Events + Touch fallback (iOS Safari 호환)
  cv.addEventListener("pointerdown", (e) => {
    if (!state.running) return;
    cv.setPointerCapture?.(e.pointerId);     // 캔버스 밖으로 나가도 up/cancel 받기
    onPointerDown(e);
  }, { passive: false });
  
  cv.addEventListener("pointermove", (e) => {
    onPointerMove(e);
  }, { passive: false });
  
  cv.addEventListener("pointerup", (e) => {
    onPointerUp(e);
    cv.releasePointerCapture?.(e.pointerId);
  }, { passive: false });

  window.addEventListener("pointerup", (e) => {
    // iOS에서 캔버스 밖으로 나가면 cv pointerup 누락되는 경우 대비
    onPointerUp(e);
  }, { passive: false });
  
  cv.addEventListener("pointercancel", (e) => {
    // ✅ 취소되면 무조건 홀드 해제
    if (state.holding) endHold();
    cv.releasePointerCapture?.(e.pointerId);
  }, { passive: false });

  if (!window.PointerEvent) {
    cv.addEventListener("touchstart", onTouchStart, { passive: false });
    cv.addEventListener("touchmove", onTouchMove, { passive: false });
    cv.addEventListener("touchend", onTouchEndOrCancel, { passive: false });
    cv.addEventListener("touchcancel", onTouchEndOrCancel, { passive: false });
  }

  // iOS Safari long-press 선택/콜아웃 방지
  cv.addEventListener("contextmenu", (e) => {
    e.preventDefault();
  }, { passive: false });

  cv.addEventListener("selectstart", (e) => {
    e.preventDefault();
  }, { passive: false });

  window.addEventListener("gesturestart", (e) => {
    if (e.target === cv) e.preventDefault();
  }, { passive: false });


  window.addEventListener("devicemotion", onDeviceMotion, { passive: true });

  $("btnStart").addEventListener("click", async () => {
    beep(660, 0.03, 0.03); // audio unlock
    const ok = await ensureMotionPermissionIfNeeded();
    if (state.optMotionThrow && !ok) {
      // 모션 권한 거부여도 게임은 정상 진행
      beep(220, 0.06, 0.05);
    }
    startGame();
  });

  $("optMotionThrow").addEventListener("change", (e) => {
    state.optMotionThrow = e.target.checked;
  });

  $("btnCloseCoupon").addEventListener("click", () => {
    hideCouponModal();
  });

  $("btnSubmit").addEventListener("click", async () => {
    const name = ($("nickname").value || "").trim().slice(0, 15);
    if (!name) {
      alert("인스타그램 ID를 입력해주세요.");
      return;
    }

    if (!firebaseReady || !db) {
      alert("서버 연결이 준비되지 않았어요. Firebase 설정을 확인해주세요.");
      return;
    }

    const score = state.score | 0;
    const bucketId = currentBucketId();
    const clientId = getClientId();

    try {
      const monsters = state.caughtSet.size;
      const maxCombo = state.maxCombo;
      await addDoc(collection(db, "scores"), {
        name,
        score,
        monsters,
        maxCombo,
        bucketId,
        clientId,
        createdAt: serverTimestamp()
      });

      const bucketSnap = await getDocs(
        query(collection(db, "scores"), where("bucketId", "==", bucketId))
      );

      const allScores = [];
      bucketSnap.forEach((doc) => allScores.push(doc.data()));
      allScores.sort((a, b) => {
        const byCombo = (Number(b.maxCombo) || 0) - (Number(a.maxCombo) || 0);
        if (byCombo !== 0) return byCombo;
        const byMonsters = (Number(b.monsters) || 0) - (Number(a.monsters) || 0);
        if (byMonsters !== 0) return byMonsters;
        return (Number(b.score) || 0) - (Number(a.score) || 0);
      });

      const higherCount = allScores.filter((row) => {
        const rc = Number(row.maxCombo) || 0;
        const rm = Number(row.monsters) || 0;
        const rs = Number(row.score) || 0;
        return rc > maxCombo || (rc === maxCombo && rm > monsters) || (rc === maxCombo && rm === monsters && rs > score);
      }).length;
      const rank = higherCount + 1;

      alert(`등록 완료! 현재 ${rank}등 입니다.`);
    } catch (err) {
      console.error("[Firebase] 점수 등록 실패", err);
      const code = err?.code || "";
      if (code === "permission-denied" || code === "PERMISSION_DENIED") {
        alert("점수 등록 권한이 없어요. Firestore 보안 규칙을 확인해주세요.\n(firestore.rules 파일 참고)");
      } else if (code === "unavailable" || code === "deadline-exceeded") {
        alert("서버에 연결할 수 없어요. 네트워크 상태를 확인해주세요.");
      } else {
        alert(`점수 등록에 실패했어요. (${code || err?.message || "알 수 없는 오류"})`);
      }
    }
  });

  function getClientId() {
    let id = localStorage.getItem("tapemongo_clientId");
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
      localStorage.setItem("tapemongo_clientId", id);
    }
    return id;
  }



  // roundRect polyfill (older Safari)
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function(x,y,w,h,r){
      r = Math.min(r, w/2, h/2);
      this.beginPath();
      this.moveTo(x+r, y);
      this.arcTo(x+w, y, x+w, y+h, r);
      this.arcTo(x+w, y+h, x, y+h, r);
      this.arcTo(x, y+h, x, y, r);
      this.arcTo(x, y, x+w, y, r);
      this.closePath();
      return this;
    };
  }

  function init() {
    resize();
    loadLocal();
    syncUI();
    syncCatchUI();
    listenTop10();   // 🔥 서버 리더보드
    requestAnimationFrame(tick);
  }

  
  
  init();
})();





























