(() => {
  // =============================
  // Utilities
  // =============================
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  const todayKey = () => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}${m}${dd}`;
  };

  // =============================
  // Audio (simple beeps via WebAudio)
  // =============================
  let audioCtx = null;
  function beep(freq = 880, dur = 0.06, gain = 0.06) {
    if (!state.optSound) return;
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

  // =============================
  // Canvas setup
  // =============================
  const cv = $("cv");
  const ctx = cv.getContext("2d");

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

  // =============================
  // Game State
  // =============================
  const world = { w: 0, h: 0 };

  const state = {
    running: false,

    // options
    optTapThrow: true,
    optSound: true,
    optShowGuide: true,
    optMotionThrow: false,
    optSensitivity: 1.0,
    optDifficulty: 2,
    optCoupon: true,
    optCouponCooldownMin: 30,

    score: 0,
    combo: 0,
    best: 0,

    // charge/throw
    charged: false,
    chargePower: 0, // 0..1
    lastThrowAt: 0,

    // motion (optional)
    motionEnabled: false,
    lastAccelZ: 0,
    motionArmed: false,

    // effects
    toastUntil: 0,
    toastText: "",

    // coupon
    lastCouponAt: 0
  };

  const target = {
    x: 0,
    y: 0,
    r: 18,
    vx: 280, // px/s
    dir: 1
  };

  const ball = {
    active: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    t: 0
  };

  // =============================
  // UI bindings
  // =============================
  function syncUI() {
    $("score").textContent = String(state.score);
    $("combo").textContent = String(state.combo);
    $("best").textContent = String(state.best);

    $("sensVal").textContent = state.optSensitivity.toFixed(2);
    $("diffVal").textContent = String(state.optDifficulty);
    $("couponState").textContent = state.optCoupon ? "ON" : "OFF";

    $("hint").classList.toggle("hidden", !state.optShowGuide);
  }

  function loadLocal() {
    try {
      const best = Number(localStorage.getItem("barcatch_best") || "0");
      state.best = isFinite(best) ? best : 0;

      const lastCouponAt = Number(localStorage.getItem("barcatch_coupon_at") || "0");
      state.lastCouponAt = isFinite(lastCouponAt) ? lastCouponAt : 0;
    } catch (_) {}
  }

  function saveBest() {
    try {
      localStorage.setItem("barcatch_best", String(state.best));
    } catch (_) {}
  }

  function saveCouponAt() {
    try {
      localStorage.setItem("barcatch_coupon_at", String(state.lastCouponAt));
    } catch (_) {}
  }

  // Leaderboard (local only)
  function lbStorageKey() {
    return `barcatch_lb_${todayKey()}`;
  }

  function getLB() {
    try {
      const raw = localStorage.getItem(lbStorageKey());
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  function setLB(arr) {
    try {
      localStorage.setItem(lbStorageKey(), JSON.stringify(arr));
    } catch (_) {}
  }

  function renderLB() {
    const list = $("lbList");
    const lb = getLB()
      .sort((a,b) => (b.score||0) - (a.score||0))
      .slice(0, 10);

    if (lb.length === 0) {
      list.innerHTML = `<div class="lbRow"><span>아직 기록이 없어요</span><span>—</span></div>`;
      return;
    }
    list.innerHTML = lb.map((e, i) => {
      const name = (e.name || "NONAME").slice(0, 6);
      const sc = e.score || 0;
      return `<div class="lbRow"><span>#${i+1} ${escapeHtml(name)}</span><span class="mono">${sc}</span></div>`;
    }).join("");
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }

  // =============================
  // Toast
  // =============================
  function toast(text, ms = 900) {
    state.toastText = text;
    state.toastUntil = performance.now() + ms;
    const t = $("toast");
    t.textContent = text;
    t.classList.remove("hidden");
  }

  function toastTick(now) {
    const t = $("toast");
    if (now < state.toastUntil) return;
    t.classList.add("hidden");
  }

  // =============================
  // Gameplay
  // =============================
  function resetRoundVisuals() {
    state.charged = false;
    state.chargePower = 0;
    state.motionArmed = false;
  }

  function resetGame() {
    state.score = 0;
    state.combo = 0;
    resetRoundVisuals();
    ball.active = false;
    syncUI();
    toast("초기화 완료", 700);
    beep(520, 0.05, 0.05);
  }

  function startGame() {
    state.running = true;
    resetRoundVisuals();
    ball.active = false;

    // target initial position
    target.y = world.h * 0.30;
    target.x = world.w * 0.5;

    toast("시작! 👇 장전 → 👆 던지기", 1000);
    beep(990, 0.06, 0.06);
  }

  function difficultySpeed(diff) {
    // 1..5
    return 220 + (diff - 1) * 90;
  }

  function updateTarget(dt) {
    target.vx = difficultySpeed(state.optDifficulty);
    target.x += target.dir * target.vx * dt;

    const margin = 24;
    if (target.x < margin) { target.x = margin; target.dir = 1; }
    if (target.x > world.w - margin) { target.x = world.w - margin; target.dir = -1; }
  }

  function launchBall(power, aimX) {
    const now = performance.now();
    if (now - state.lastThrowAt < 350) return; // anti-spam
    state.lastThrowAt = now;

    ball.active = true;
    ball.t = 0;
    ball.x = world.w * 0.5;
    ball.y = world.h * 0.88;

    // We "aim" the ball horizontally towards the swipe end / tap point
    const dx = (aimX - ball.x);
    const maxDx = world.w * 0.45;
    const nx = clamp(dx / maxDx, -1, 1);

    const p = clamp(power, 0.05, 1.0);
    // velocity tuned for nice feel
    ball.vx = nx * (380 * p);
    ball.vy = -(720 * (0.55 + 0.55 * p)); // upward

    beep(880 + 250 * p, 0.05, 0.06);
  }

  function updateBall(dt) {
    if (!ball.active) return;

    const g = 1450; // gravity px/s^2
    ball.vy += g * dt;

    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // detect "crossing" the target line (around target.y)
    // We'll judge when the ball is near target.y (within window) and moving downward past it
    const yWindow = 16;
    if (Math.abs(ball.y - target.y) < yWindow && ball.vy > 0) {
      judgeCatch();
    }

    // out of bounds
    if (ball.y > world.h + 60 || ball.x < -60 || ball.x > world.w + 60) {
      ball.active = false;
    }
  }

  function judgeCatch() {
    if (!ball.active) return;
    ball.active = false;

    const dist = Math.abs(ball.x - target.x);
    const perfect = 10;
    const great = 22;
    const nice = 36;

    let label = "MISS";
    let add = 0;

    if (dist <= perfect) { label = "PERFECT"; add = 300; }
    else if (dist <= great) { label = "GREAT"; add = 180; }
    else if (dist <= nice) { label = "NICE"; add = 100; }

    if (label === "MISS") {
      state.combo = 0;
      toast("MISS 😵", 700);
      beep(220, 0.08, 0.06);
      syncUI();
      return;
    }

    state.combo += 1;
    const comboMul = 1 + Math.min(0.6, state.combo * 0.06);
    const gained = Math.round(add * comboMul);

    state.score += gained;
    if (state.score > state.best) {
      state.best = state.score;
      saveBest();
    }

    toast(`${label} +${gained}`, 900);
    beep(label === "PERFECT" ? 1200 : label === "GREAT" ? 980 : 820, 0.06, 0.07);

    // Coupon trigger example: PERFECT or combo milestone
    if (state.optCoupon) {
      const got = (label === "PERFECT") || (state.combo > 0 && state.combo % 5 === 0);
      if (got) maybeShowCoupon();
    }

    syncUI();
  }

  function maybeShowCoupon() {
    const now = Date.now();
    const cooldownMs = state.optCouponCooldownMin * 60 * 1000;
    if (now - state.lastCouponAt < cooldownMs) return;

    // generate a short coupon code (display-only)
    const code = makeCouponCode();
    state.lastCouponAt = now;
    saveCouponAt();

    // 안내: 직원에게 보여주는 형태
    toast(`쿠폰! 바텐더에게 보여주세요: ${code}`, 2500);
  }

  function makeCouponCode() {
    // deterministic enough but fine for display
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let s = "BAR-";
    for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  // =============================
  // Swipe + Tap input
  // =============================
  let touch = {
    active: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    startAt: 0
  };

  function onPointerDown(e) {
    if (!state.running) return;

    const p = getPoint(e);
    touch.active = true;
    touch.startX = p.x;
    touch.startY = p.y;
    touch.lastX = p.x;
    touch.lastY = p.y;
    touch.startAt = performance.now();
  }

  function onPointerMove(e) {
    if (!touch.active || !state.running) return;
    const p = getPoint(e);
    touch.lastX = p.x;
    touch.lastY = p.y;

    const dy = (touch.lastY - touch.startY);
    // swipe down to charge: dy positive
    if (dy > 0) {
      const sens = state.optSensitivity;
      const power = clamp((dy / (world.h * 0.35)) * sens, 0, 1);
      state.charged = power > 0.08;
      state.chargePower = power;
    }
  }

  function onPointerUp(e) {
    if (!touch.active || !state.running) return;
    touch.active = false;

    const p = getPoint(e);
    const dx = p.x - touch.startX;
    const dy = p.y - touch.startY;
    const dt = Math.max(1, performance.now() - touch.startAt);

    const sens = state.optSensitivity;

    // Swipe up throw: dy negative and sufficiently large
    // Also require that user previously charged a bit (or allow throw w/ up swipe alone using "virtual power")
    const swipeUp = dy < -(40 * sens);
    const swipeDown = dy > (40 * sens);

    // "tap" (small movement, quick)
    const isTap = Math.abs(dx) < 10 && Math.abs(dy) < 10 && dt < 250;

    if (isTap && state.optTapThrow) {
      // quick tap throw (uses current charge or a baseline)
      const power = clamp(state.chargePower > 0.05 ? state.chargePower : 0.45, 0.1, 1.0);
      launchBall(power, p.x);
      resetRoundVisuals();
      return;
    }

    if (swipeDown) {
      // already handled in move; keep charged
      if (state.charged) toast(`장전 ${Math.round(state.chargePower*100)}%`, 550);
      return;
    }

    if (swipeUp) {
      // Up throw: if user didn't charge, infer power from swipe speed/length
      let power = state.chargePower;
      if (power < 0.08) {
        const speed = Math.abs(dy) / dt; // px/ms
        power = clamp(speed * 0.9 * sens, 0.25, 0.95);
      }
      launchBall(power, p.x);
      resetRoundVisuals();
      return;
    }
  }

  function getPoint(e) {
    const rect = cv.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
    return { x, y };
  }

  // =============================
  // Motion throw (optional)
  // =============================
  async function ensureMotionPermissionIfNeeded() {
    // Only for iOS (requestPermission). Android usually doesn't need.
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

    // Simple "forward snap" detector on z-axis change (device dependent).
    // Keep it as a bonus mode, not the main.
    const z = acc.z || 0;
    const dz = z - state.lastAccelZ;
    state.lastAccelZ = z;

    // arm when charged (tilt-free: use charge gesture as the arm)
    if (state.charged) state.motionArmed = true;

    // detect a sharp movement
    const thresh = 6.0 * state.optSensitivity;
    if (state.motionArmed && dz < -thresh) {
      // throw straight to center
      const power = clamp(state.chargePower > 0.1 ? state.chargePower : 0.55, 0.2, 1.0);
      launchBall(power, world.w * 0.5);
      resetRoundVisuals();
      state.motionArmed = false;
    }
  }

  // =============================
  // Render
  // =============================
  function drawBackground() {
    const w = world.w, h = world.h;

    // grid-ish subtle
    ctx.save();
    ctx.clearRect(0, 0, w, h);

    // vignette
    const g = ctx.createRadialGradient(w*0.5, h*0.1, 20, w*0.5, h*0.5, Math.max(w,h));
    g.addColorStop(0, "rgba(110,231,255,0.12)");
    g.addColorStop(0.55, "rgba(255,255,255,0.00)");
    g.addColorStop(1, "rgba(0,0,0,0.25)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // floor line
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w*0.08, h*0.88);
    ctx.lineTo(w*0.92, h*0.88);
    ctx.stroke();

    ctx.restore();
  }

  function drawTarget() {
    // "Spark" (original)
    ctx.save();
    ctx.translate(target.x, target.y);

    // glow
    ctx.beginPath();
    ctx.fillStyle = "rgba(110,231,255,0.18)";
    ctx.arc(0, 0, target.r * 2.2, 0, Math.PI * 2);
    ctx.fill();

    // body
    ctx.beginPath();
    ctx.fillStyle = "rgba(234,240,255,0.9)";
    ctx.arc(0, 0, target.r, 0, Math.PI * 2);
    ctx.fill();

    // lightning mark
    ctx.strokeStyle = "rgba(17,24,36,0.9)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-6, -2);
    ctx.lineTo(-1, -10);
    ctx.lineTo(3, -1);
    ctx.lineTo(8, -8);
    ctx.stroke();

    ctx.restore();
  }

  function drawBall() {
    // "Capsule" (original)
    const baseX = world.w * 0.5;
    const baseY = world.h * 0.88;

    // draw launcher / charge
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

    // active capsule
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

    // capsule body
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
    ctx.fillStyle = "rgba(234,240,255,0.75)";
    ctx.font = "14px ui-sans-serif, system-ui, -apple-system, Apple SD Gothic Neo, Noto Sans KR, sans-serif";

    if (!state.running) {
      ctx.fillText("플레이 시작을 누르세요", 18, 28);
      ctx.restore();
      return;
    }

    if (state.charged) {
      ctx.fillText(`CHARGE ${Math.round(state.chargePower * 100)}%`, 18, 28);
    } else {
      ctx.fillText("👇 아래로 스와이프(장전) / 👆 위로 스와이프(던지기)", 18, 28);
    }

    ctx.restore();
  }

  // =============================
  // Main loop
  // =============================
  let last = performance.now();
  function tick(now) {
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;

    if (state.running) {
      updateTarget(dt);
      updateBall(dt);
    }

    drawBackground();
    drawTarget();
    drawBall();
    drawHUDText();
    toastTick(now);

    requestAnimationFrame(tick);
  }

  // =============================
  // Events
  // =============================
  cv.addEventListener("touchstart", onPointerDown, { passive: false });
  cv.addEventListener("touchmove", onPointerMove, { passive: false });
  cv.addEventListener("touchend", onPointerUp, { passive: false });

  // Also support mouse for quick testing on desktop
  cv.addEventListener("mousedown", onPointerDown);
  window.addEventListener("mousemove", onPointerMove);
  window.addEventListener("mouseup", onPointerUp);

  $("btnStart").addEventListener("click", async () => {
    // make sure audio works (user gesture)
    if (state.optSound) beep(660, 0.03, 0.03);

    // motion permission if user enabled it
    const ok = await ensureMotionPermissionIfNeeded();
    if (state.optMotionThrow && !ok) {
      toast("모션 권한이 필요해요(설정 확인)", 1400);
    } else if (state.optMotionThrow) {
      toast("모션 던지기 ON", 900);
    }

    startGame();
  });

  $("btnReset").addEventListener("click", resetGame);

  // options
  $("optTapThrow").addEventListener("change", (e) => { state.optTapThrow = e.target.checked; syncUI(); });
  $("optSound").addEventListener("change", (e) => { state.optSound = e.target.checked; syncUI(); });
  $("optShowGuide").addEventListener("change", (e) => { state.optShowGuide = e.target.checked; syncUI(); });
  $("optMotionThrow").addEventListener("change", (e) => {
    state.optMotionThrow = e.target.checked;
    syncUI();
    toast(state.optMotionThrow ? "고급 모드: 모션 던지기 ON" : "모션 던지기 OFF", 900);
  });
  $("optSensitivity").addEventListener("input", (e) => { state.optSensitivity = Number(e.target.value); syncUI(); });
  $("optDifficulty").addEventListener("input", (e) => { state.optDifficulty = Number(e.target.value); syncUI(); });
  $("optCoupon").addEventListener("change", (e) => { state.optCoupon = e.target.checked; syncUI(); });
  $("optCouponCooldown").addEventListener("input", (e) => {
    state.optCouponCooldownMin = Number(e.target.value);
    $("cdVal").textContent = String(state.optCouponCooldownMin);
  });

  // leaderboard submit
  $("btnSubmit").addEventListener("click", () => {
    const name = ($("nickname").value || "").trim().slice(0, 6);
    if (!name) { toast("닉네임을 입력해 주세요", 900); return; }

    const lb = getLB();
    lb.push({ name, score: state.score, at: Date.now() });
    setLB(lb);

    toast("등록 완료!", 900);
    beep(920, 0.05, 0.05);
    renderLB();
  });

  // device motion listener (optional)
  window.addEventListener("devicemotion", onDeviceMotion, { passive: true });

  // =============================
  // Init
  // =============================
  function init() {
    resize();
    loadLocal();

    // init values from DOM
    state.optTapThrow = $("optTapThrow").checked;
    state.optSound = $("optSound").checked;
    state.optShowGuide = $("optShowGuide").checked;
    state.optMotionThrow = $("optMotionThrow").checked;
    state.optSensitivity = Number($("optSensitivity").value);
    state.optDifficulty = Number($("optDifficulty").value);
    state.optCoupon = $("optCoupon").checked;
    state.optCouponCooldownMin = Number($("optCouponCooldown").value);
    $("cdVal").textContent = String(state.optCouponCooldownMin);

    syncUI();
    renderLB();
    requestAnimationFrame(tick);
  }

  // canvas roundRect polyfill for older safari
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

  init();
})();
