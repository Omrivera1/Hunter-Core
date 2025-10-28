/* HUNTER-CORE r19
   - Slower, buttery aim smoothing (no snap)
   - Right-stick aim only (movement never yanks your barrel)
   - L2 hold = smooth zoom
   - Fire modes: AUTO (default) / SEMI / BURST (cycle with Y/Triangle)
   - Faster single-projectile with clean trail (no "multi-bullet" smear)
   - Impact sparks + enemy knockback tuned (lighter) + HP bar
   - Grounded recoil (small push, no butter slide)
   - Solid collisions + edge clamping
   - Controller HUD fixed & non-overlapping
*/

(() => {
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d', { alpha: false });

  // ---------- CONFIG ----------
  const CFG = {
    world: { w: 3200, h: 2000, grid: 64 },
    player: {
      radius: 22,
      accel: 2400,         // stronger movement so it never feels "glued"
      maxSpeed: 420,       // top speed
      friction: 0.90,      // high = more glide, lower = more grip
      recoilPush: 90,      // push per shot (grounded feel)
      turnSpeed: 7.0,      // HOW FAST barrel rotates toward target (lower = slower)
      zoom: { normal: 1.0, aim: 1.25, lerp: 6.0 }, // L2 zoom
    },
    bullet: {
      speed: 1600,
      life: 0.9,          // seconds on straight flight
      radius: 4,
      trail: { width: 5, fade: 280, nodes: 12 }, // clean single trail
      damage: 12,
      burstCount: 3,
      burstGap: 0.05
    },
    fire: {
      mode: 'auto', // 'auto' | 'semi' | 'burst'
      rpmAuto: 720, // ~12/s
      rpmSemi: 8,   // gated by click
    },
    enemy: {
      w: 78, h: 62, hp: 120,
      knock: 140, friction: 0.86
    },
    pad: {
      deadzone: 0.17
    }
  };

  // ---------- STATE ----------
  const state = {
    time: 0,
    dt: 0,
    gamepads: [],
    fireMode: CFG.fire.mode,
    lastShot: 0,
    burstLeft: 0,
    burstTimer: 0,
    zoom: CFG.player.zoom.normal,
    zoomTarget: CFG.player.zoom.normal,
    hud: { hasPad: false, mode: 'AUTO' }
  };

  // Player
  const player = {
    x: 1600, y: 1000,
    vx: 0, vy: 0,
    aimAngle: 0,          // current barrel rotation
    aimTarget: 0,         // desired rotation from right stick
  };

  // Enemy (simple single target for now)
  const enemy = {
    x: 2200, y: 950,
    w: CFG.enemy.w, h: CFG.enemy.h,
    vx: 0, vy: 0,
    hp: CFG.enemy.hp, alive: true, flash: 0
  };

  // Obstacles
  const boxes = [
    {x: 1350, y: 980, w: 260, h: 120},
    {x: 2500, y: 1160, w: 180, h: 180},
    {x: 3000, y: 760,  w: 140, h: 420},
  ];

  // Projectiles & impacts
  const bullets = [];
  const sparks  = [];

  // Camera
  const camera = { x: 0, y: 0, w: 0, h: 0 };

  // ---------- UTILS ----------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp  = (a, b, t) => a + (b - a) * clamp(t, 0, 1);
  const angLerp = (a, b, t) => {
    let d = ((b - a + Math.PI*3) % (Math.PI*2)) - Math.PI;
    return a + d * t;
  };
  const len = (x,y)=>Math.hypot(x,y);

  function resize() {
    canvas.width  = innerWidth * devicePixelRatio;
    canvas.height = innerHeight * devicePixelRatio;
    ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
    camera.w = canvas.width / devicePixelRatio;
    camera.h = canvas.height / devicePixelRatio;
  }
  addEventListener('resize', resize);
  resize();

  // ---------- INPUT ----------
  const keys = Object.create(null);
  addEventListener('keydown', e => keys[e.code] = true);
  addEventListener('keyup',   e => keys[e.code] = false);

  function pollPads() {
    const pads = navigator.getGamepads?.() || [];
    state.gamepads = [];
    state.hud.hasPad = false;
    for (const p of pads) if (p) {
      state.gamepads.push(p);
      state.hud.hasPad = true;
    }
  }

  function axisWithDZ(v) {
    return Math.abs(v) < CFG.pad.deadzone ? 0 : v;
  }

  function readMoveAim() {
    const gp = state.gamepads[0];
    let lx=0, ly=0, rx=0, ry=0;
    let fireHeld = false, zoomHeld = false, cyclePressed = false;

    if (gp) {
      lx = axisWithDZ(gp.axes[0] || 0);
      ly = axisWithDZ(gp.axes[1] || 0);
      rx = axisWithDZ(gp.axes[2] || 0);
      ry = axisWithDZ(gp.axes[3] || 0);
      // buttons: R2=7, L2=6, Y/Triangle=3 (common mapping)
      fireHeld = !!(gp.buttons[7]?.pressed);
      zoomHeld = !!(gp.buttons[6]?.pressed);
      cyclePressed = justPressed(gp, 3);
    } else {
      // KB fallback: WASD move, mouse aim, Space = fire, Shift = zoom, F = cycle
      lx = (keys.KeyD?1:0) - (keys.KeyA?1:0);
      ly = (keys.KeyS?1:0) - (keys.KeyW?1:0);
      fireHeld = !!keys.Space;
      zoomHeld = !!keys.ShiftLeft || !!keys.ShiftRight;
      cyclePressed = eatKey('KeyF');
      // Mouse aim to cursor center
      // (optional later -- right now stick-only is fine)
    }

    // Cycle fire mode
    if (cyclePressed) {
      state.fireMode = state.fireMode === 'auto' ? 'semi'
                     : state.fireMode === 'semi' ? 'burst'
                     : 'auto';
      state.hud.mode = state.fireMode.toUpperCase();
    }

    return {lx, ly, rx, ry, fireHeld, zoomHeld};
  }

  let _prevButtons = [];
  function justPressed(gp, idx) {
    const now = !!(gp.buttons[idx]?.pressed);
    const before = _prevButtons[idx] || false;
    _prevButtons[idx] = now;
    return now && !before;
  }
  function eatKey(code) {
    if (keys[code]) { keys[code] = false; return true; }
    return false;
  }

  // ---------- GAME LOGIC ----------
  function spawnBullet(x,y,ang) {
    const sp = CFG.bullet.speed;
    const b = {
      x,y,
      vx: Math.cos(ang)*sp,
      vy: Math.sin(ang)*sp,
      t: 0,
      life: CFG.bullet.life,
      trail: []
    };
    bullets.push(b);

    // Recoil push (grounded amount)
    player.vx -= Math.cos(ang) * CFG.player.recoilPush;
    player.vy -= Math.sin(ang) * CFG.player.recoilPush;
  }

  function fireControl(fireHeld, dt) {
    const now = state.time;

    if (state.fireMode === 'auto') {
      const gap = 60 / CFG.fire.rpmAuto;
      if (fireHeld && now - state.lastShot >= gap) {
        spawnBulletFromBarrel();
        state.lastShot = now;
      }
    } else if (state.fireMode === 'semi') {
      // semi requires edge (R2 press)
      // handled by justPressed already via gamepad; fallback for KB:
      if (fireHeld && now - state.lastShot > (1/CFG.fire.rpmSemi)) {
        spawnBulletFromBarrel();
        state.lastShot = now;
      }
    } else if (state.fireMode === 'burst') {
      const gap = 0.18; // min gap between bursts
      if (fireHeld && state.burstLeft === 0 && now - state.lastShot >= gap) {
        state.burstLeft = CFG.bullet.burstCount;
        state.burstTimer = 0;
        state.lastShot = now;
      }
      if (state.burstLeft > 0) {
        state.burstTimer -= dt;
        if (state.burstTimer <= 0) {
          spawnBulletFromBarrel();
          state.burstLeft--;
          state.burstTimer = CFG.bullet.burstGap;
        }
      }
    }
  }

  function spawnBulletFromBarrel() {
    const ang = player.aimAngle;
    const muzzle = player.radius || CFG.player.radius;
    const bx = player.x + Math.cos(ang) * (muzzle + 8);
    const by = player.y + Math.sin(ang) * (muzzle + 8);
    spawnBullet(bx, by, ang);
  }

  function integratePlayer(inp, dt) {
    // Zoom
    state.zoomTarget = inp.zoomHeld ? CFG.player.zoom.aim : CFG.player.zoom.normal;
    state.zoom = lerp(state.zoom, state.zoomTarget, Math.min(1, CFG.player.zoom.lerp*dt));

    // Movement (left stick)
    let ax = inp.lx * CFG.player.accel;
    let ay = inp.ly * CFG.player.accel;
    player.vx += ax * dt;
    player.vy += ay * dt;

    // Speed clamp
    const sp = len(player.vx, player.vy);
    const max = CFG.player.maxSpeed;
    if (sp > max) {
      const s = max / sp;
      player.vx *= s; player.vy *= s;
    }

    // Friction (grounded feel)
    player.vx *= Math.pow(CFG.player.friction, Math.max(1, 60*dt));
    player.vy *= Math.pow(CFG.player.friction, Math.max(1, 60*dt));

    // Position
    player.x += player.vx * dt;
    player.y += player.vy * dt;

    // Collide with boxes (AABB resolve)
    resolveCollisionsCircle(player, CFG.player.radius, boxes);

    // Clamp to world
    player.x = clamp(player.x, CFG.player.radius, CFG.world.w - CFG.player.radius);
    player.y = clamp(player.y, CFG.player.radius, CFG.world.h - CFG.player.radius);

    // Aim from right stick (if neutral, keep last)
    if (Math.abs(inp.rx) > 0 || Math.abs(inp.ry) > 0) {
      player.aimTarget = Math.atan2(inp.ry, inp.rx);
    }
    // Smooth rotate toward target
    const t = Math.min(1, CFG.player.turnSpeed * dt);
    player.aimAngle = angLerp(player.aimAngle, player.aimTarget, t);
  }

  function resolveCollisionsCircle(p, r, rects) {
    for (const b of rects) {
      const nx = clamp(p.x, b.x, b.x + b.w);
      const ny = clamp(p.y, b.y, b.y + b.h);
      const dx = p.x - nx, dy = p.y - ny;
      const d2 = dx*dx + dy*dy, rr = r*r;
      if (d2 < rr) {
        const d = Math.max(0.001, Math.sqrt(d2));
        const px = dx / d, py = dy / d;
        const push = r - d;
        p.x += px * push;
        p.y += py * push;
        // cancel velocity along normal (stops jitter)
        const vn = p.vx*px + p.vy*py;
        if (vn < 0) {
          p.vx -= vn * px;
          p.vy -= vn * py;
        }
      }
    }
  }

  function updateBullets(dt) {
    for (let i = bullets.length-1; i >= 0; --i) {
      const b = bullets[i];
      b.t += dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      // trail
      b.trail.push({x:b.x, y:b.y, t: state.time});
      if (b.trail.length > CFG.bullet.trail.nodes) b.trail.shift();

      // world or box collision
      let hit = false;
      if (b.x < 0 || b.y < 0 || b.x > CFG.world.w || b.y > CFG.world.h) hit = true;
      else {
        for (const bx of boxes) {
          if (b.x > bx.x && b.x < bx.x+bx.w && b.y > bx.y && b.y < bx.y+bx.h) { hit = true; break; }
        }
      }
      // enemy collision
      if (!hit && enemy.alive) {
        if (b.x > enemy.x && b.x < enemy.x+enemy.w && b.y > enemy.y && b.y < enemy.y+enemy.h) {
          hit = true;
          enemy.hp -= CFG.bullet.damage;
          enemy.flash = 0.08;
          // light knockback (reduced)
          const a = Math.atan2(b.vy, b.vx);
          enemy.vx += Math.cos(a) * CFG.enemy.knock;
          enemy.vy += Math.sin(a) * CFG.enemy.knock;
          if (enemy.hp <= 0) enemy.alive = false;
        }
      }

      if (hit || b.t >= b.life) {
        spawnSparks(b.x, b.y, Math.atan2(b.vy,b.vx));
        bullets.splice(i,1);
      }
    }
  }

  function spawnSparks(x,y,ang) {
    const n=10;
    for (let i=0;i<n;i++){
      const a = ang + (Math.random()-0.5)*0.8;
      const s = 220 + Math.random()*220;
      sparks.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,t:0,life:0.25});
    }
  }

  function updateSparks(dt){
    for (let i=sparks.length-1;i>=0;--i){
      const s = sparks[i];
      s.t += dt;
      s.vx *= 0.92; s.vy *= 0.92;
      s.x += s.vx*dt; s.y += s.vy*dt;
      if (s.t>=s.life) sparks.splice(i,1);
    }
  }

  function updateEnemy(dt){
    if (!enemy.alive) return;
    enemy.x += enemy.vx*dt;
    enemy.y += enemy.vy*dt;
    enemy.vx *= Math.pow(CFG.enemy.friction, Math.max(1,60*dt));
    enemy.vy *= Math.pow(CFG.enemy.friction, Math.max(1,60*dt));
    // collide with boxes & world
    const rect = {x:enemy.x,y:enemy.y,w:enemy.w,h:enemy.h};
    // simple world clamp
    enemy.x = clamp(enemy.x, 0, CFG.world.w - enemy.w);
    enemy.y = clamp(enemy.y, 0, CFG.world.h - enemy.h);
    // box separation
    for (const b of boxes){
      if (rectsOverlap(enemy,b)){
        // push out along smallest axis
        const dx1 = (b.x + b.w) - enemy.x;       // from left
        const dx2 = (enemy.x + enemy.w) - b.x;   // from right
        const dy1 = (b.y + b.h) - enemy.y;       // from top
        const dy2 = (enemy.y + enemy.h) - b.y;   // from bottom
        const m = Math.min(dx1,dx2,dy1,dy2);
        if (m===dx1) enemy.x = b.x + b.w;
        else if (m===dx2) enemy.x = b.x - enemy.w;
        else if (m===dy1) enemy.y = b.y + b.h;
        else enemy.y = b.y - enemy.h;
      }
    }
    if (enemy.flash>0) enemy.flash -= dt;
  }
  const rectsOverlap=(a,b)=>a.x<b.x+b.w && a.x+a.w>b.x && a.y<b.y+b.h && a.y+a.h>b.y;

  function updateCamera(dt){
    camera.x = clamp(player.x - camera.w*0.5/state.zoom, 0, CFG.world.w - camera.w/state.zoom);
    camera.y = clamp(player.y - camera.h*0.5/state.zoom, 0, CFG.world.h - camera.h/state.zoom);
  }

  // ---------- RENDER ----------
  function drawGrid() {
    const g = CFG.world.grid;
    ctx.fillStyle = '#0f1620';
    ctx.fillRect(0,0,camera.w,camera.h);

    ctx.save();
    ctx.translate(-camera.x, -camera.y);
    ctx.strokeStyle = '#1c2633';
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1;
    for (let x=0; x<=CFG.world.w; x+=g){
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,CFG.world.h); ctx.stroke();
    }
    for (let y=0; y<=CFG.world.h; y+=g){
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(CFG.world.w,y); ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function beginWorld() {
    ctx.save();
    // Letterbox-safe zoom anchored to top-left of camera
    ctx.translate(0,0);
    ctx.scale(state.zoom, state.zoom);
    ctx.translate(-camera.x, -camera.y);
  }
  function endWorld(){ ctx.restore(); }

  function drawBoxes() {
    ctx.fillStyle = 'rgba(80,90,110,0.35)';
    ctx.strokeStyle = 'rgba(180,200,220,0.25)';
    for (const b of boxes) {
      ctx.fillRect(b.x,b.y,b.w,b.h);
      ctx.strokeRect(b.x,b.y,b.w,b.h);
    }
  }

  function drawEnemy(){
    if (!enemy.alive) return;
    ctx.save();
    if (enemy.flash>0) { ctx.globalAlpha = 0.6; }
    ctx.fillStyle = '#445064';
    ctx.strokeStyle = '#b8c6d8';
    ctx.lineWidth = 2;
    ctx.fillRect(enemy.x,enemy.y,enemy.w,enemy.h);
    ctx.strokeRect(enemy.x,enemy.y,enemy.w,enemy.h);
    // HP bar
    const pad=6, bw=enemy.w, bh=6;
    const p = clamp(enemy.hp/CFG.enemy.hp, 0, 1);
    ctx.fillStyle = '#ff6161';
    ctx.fillRect(enemy.x, enemy.y-10, bw, bh);
    ctx.fillStyle = '#4af59a';
    ctx.fillRect(enemy.x, enemy.y-10, bw*p, bh);
    ctx.restore();
  }

  function drawPlayer(){
    // barrel
    const L = 36;
    const bx1 = player.x + Math.cos(player.aimAngle)*8;
    const by1 = player.y + Math.sin(player.aimAngle)*8;
    const bx2 = player.x + Math.cos(player.aimAngle)*(8+L);
    const by2 = player.y + Math.sin(player.aimAngle)*(8+L);
    ctx.strokeStyle = '#7da7ff';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(bx1,by1); ctx.lineTo(bx2,by2); ctx.stroke();

    // body
    ctx.fillStyle = '#e9eef7';
    ctx.beginPath();
    ctx.arc(player.x, player.y, CFG.player.radius, 0, Math.PI*2);
    ctx.fill();
  }

  function drawBullets(){
    // trails first
    for (const b of bullets) {
      if (b.trail.length < 2) continue;
      ctx.save();
      ctx.strokeStyle = '#6aa0ff';
      ctx.lineCap = 'round';
      for (let i=1;i<b.trail.length;i++){
        const a = i/(b.trail.length-1);
        ctx.globalAlpha = (1-a)*0.6;
        ctx.lineWidth = lerp(CFG.bullet.trail.width, 1.0, a);
        const p0 = b.trail[i-1], p1 = b.trail[i];
        ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
      }
      ctx.restore();
    }
    // bullet heads
    ctx.fillStyle = '#dfe8ff';
    for (const b of bullets){
      ctx.beginPath();
      ctx.arc(b.x,b.y,CFG.bullet.radius,0,Math.PI*2);
      ctx.fill();
    }
  }

  function drawSparks(){
    ctx.fillStyle = '#9ec7ff';
    for (const s of sparks){
      const a = 1 - (s.t/s.life);
      ctx.globalAlpha = a;
      ctx.fillRect(s.x-1.5, s.y-1.5, 3, 3);
    }
    ctx.globalAlpha = 1;
  }

  function drawHUD(){
    // top-left controller info
    ctx.save();
    ctx.setTransform(1,0,0,1,0,0);
    ctx.fillStyle = 'rgba(20,26,34,0.75)';
    ctx.fillRect(14,14,260,68);
    ctx.fillStyle = '#cfe2ff';
    ctx.font = '16px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText(state.hud.hasPad ? 'Controller ✓' : 'Controller ?', 28, 40);
    ctx.fillText(`Mode: ${state.hud.mode}`, 28, 64);

    // bottom-left status
    ctx.fillStyle = 'rgba(20,26,34,0.6)';
    const text = 'Controller OK';
    const tw = ctx.measureText(text).width;
    ctx.fillRect(12, camera.h-34, tw+16, 26);
    ctx.fillStyle = '#cfe2ff';
    ctx.fillText(text, 20, camera.h-16);
    ctx.restore();
  }

  // ---------- MAIN LOOP ----------
  let last = performance.now()/1000;
  function frame(nowMs){
    const now = nowMs/1000;
    let dt = Math.min(0.033, now - last); // clamp 30 FPS max step
    last = now;
    state.time = now;
    state.dt = dt;

    pollPads();
    const inp = readMoveAim();

    integratePlayer(inp, dt);
    fireControl(inp.fireHeld, dt);
    updateBullets(dt);
    updateSparks(dt);
    updateEnemy(dt);
    updateCamera(dt);

    // DRAW
    ctx.save();
    ctx.clearRect(0,0,canvas.width,canvas.height);
    drawGrid();
    ctx.save();
    beginWorld();
    drawBoxes();
    drawEnemy();
    drawBullets();
    drawSparks();
    drawPlayer();
    endWorld();
    ctx.restore();
    drawHUD();
    ctx.restore();

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();