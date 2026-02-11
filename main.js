(() => {
  // =============================
  // ===== 운영자 설정(여기만 수정) =====
  // =============================
  const DEFAULT_DIFFICULTY = 4;      // 1~5  (타겟 이동 속도)
  const DEFAULT_SENSITIVITY = 1.0;   // 내부 계산용(현재 고정)
  const COUPON_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2시간
  const TARGET_HIT_RADIUS = 24;      // ✅ 히트박스 반경(px). PNG 크기와 분리(추천)
  const TARGET_IMG_SRC = "target.png"; // ✅ PNG 쓰려면 같은 폴더에 target.png 업로드
  const USE_TARGET_IMAGE = true;     // PNG 사용할지 여부
  // =============================

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

  // Target image
  const targetImg = new Image();
  let targetImgReady = false;
  if (USE_TARGET_IMAGE) {
    targetImg.onload = () => { targetImgReady = true; };
    targetImg.src = TARGET_IMG_SRC;
  }

  // Game state
  const state = {
    running: false,

    // option (only)
    optMotionThrow: false,

    score: 0,
    combo: 0,
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
  };

  const target = {
    x: 0,
    y: 0,
    dir: 1,
    vx: 0,
    hitR: TARGET_HIT_RADIUS,

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
  };

  function difficultySpeed(diff) {
    // 1..5
    return 220 + (diff - 1) * 90;
  }

  // UI sync
  function syncUI() {
    $("score").textContent = String(state.score);
    $("combo").textContent = String(state.combo);
    $("best").textContent = String(state.best);
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
      const name = (e.name||"NONAME").slice(0,6);
      const sc = e.score||0;
      return `<div class="lbRow"><span>#${i+1} ${escapeHtml(name)}</span><span class="mono">${sc}</span></div>`;
    }).join("");
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
  function maybeShowCouponOnCombo3() {
    // 3연속 콤보일때만 (3,6,9... 도 “3연속” 달성으로 보고 발급)
    if (state.combo < 3) return;
    if (state.combo % 3 !== 0) return;

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
    target.vx = difficultySpeed(state.difficulty);
    beep(990, 0.06, 0.06);
  }

  function updateTarget(dt) {
    target.vx = difficultySpeed(state.difficulty);
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

    ball.vx = nx * (420 * p);
    ball.vy = -(760 * (0.50 + 0.60 * p));

    beep(880 + 280 * p, 0.05, 0.06);
  }

  function updateBall(dt) {
    if (!ball.active) return;

    const g = 1450;
    ball.vy += g * dt;

    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // 판정: 타겟 y 근처 & 내려오는 구간
    const yWindow = 16;
    if (Math.abs(ball.y - target.y) < yWindow && ball.vy > 0) {
      judgeCatch();
    }

    if (ball.y > world.h + 60 || ball.x < -60 || ball.x > world.w + 60) {
      ball.active = false;
    }
  }

  function judgeCatch() {
    if (!ball.active) return;
    ball.active = false;

    const dist = Math.abs(ball.x - target.x);

    // 히트박스 기준으로 단계 판정
    const perfect = target.hitR * 0.35;
    const great   = target.hitR * 0.70;
    const nice    = target.hitR * 1.05;

    let add = 0;
    let label = "MISS";
    if (dist <= perfect) { label = "PERFECT"; add = 300; }
    else if (dist <= great) { label = "GREAT"; add = 180; }
    else if (dist <= nice) { label = "NICE"; add = 100; }

    if (label === "MISS") {
      state.combo = 0;
      beep(220, 0.08, 0.06);
      syncUI();
      return;
    }

    state.combo += 1;
    const comboMul = 1 + Math.min(0.6, state.combo * 0.06);
    const gained = Math.round(add * comboMul);

    state.score += gained;
    if (state.score > state.best) { state.best = state.score; saveBest(); }

    if (label === "PERFECT") beep(1200, 0.06, 0.08);
    else if (label === "GREAT") beep(980, 0.06, 0.07);
    else beep(820, 0.06, 0.06);

    // ✅ 3연속 콤보 쿠폰
    maybeShowCouponOnCombo3();

    syncUI();
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

    if (USE_TARGET_IMAGE && targetImgReady) {
      // 이미지 중심 기준으로 그리기
      const w = target.drawW;
      const h = target.drawH;
      ctx.drawImage(targetImg, -w/2, -h/2, w, h);
    } else {
      // fallback (원형)
      ctx.beginPath();
      ctx.fillStyle = "rgba(234,240,255,0.9)";
      ctx.arc(0, 0, 18, 0, Math.PI * 2);
      ctx.fill();
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
      ctx.fillText("Tap & Hold → Release to throw", 18, 28);
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
    }

    drawBackground();
    drawTarget();
    drawBall();
    drawHUDText();

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

  $("btnSubmit").addEventListener("click", () => {
    const name = ($("nickname").value || "").trim().slice(0, 6);
    if (!name) { beep(220, 0.06, 0.05); return; }
    const lb = getLB();
    lb.push({ name, score: state.score, at: Date.now() });
    setLB(lb);
    renderLB();
    beep(920, 0.05, 0.05);
  });

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
    renderLB();
    requestAnimationFrame(tick);
  }

  init();
})();




