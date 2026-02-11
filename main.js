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
    r
