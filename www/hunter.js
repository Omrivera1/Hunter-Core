/* HUNTER-CORE r17
   - Smooth aim, recoil, trail, sparks, walls, HP pips
   - Weapon system: SEMI / AUTO / BURST (+ toggle)
   - HUD fixed (top-left), controller check
   - LT/L2 precision + light zoom
*/

(() => {
  // ---------- Canvas / Setup ----------
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d', { alpha: false });
  function resize() {
    const dpr = devicePixelRatio || 1;
    canvas.width  = Math.floor(innerWidth  * dpr);
    canvas.height = Math.floor(innerHeight * dpr);
    canvas.style.width  = '100%';
    canvas.style.height = '100%';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  addEventListener('resize', resize, { passive: true });
  resize();

  // ---------- Config ----------
  const CFG = {
    grid: 64,
    accel: 2.5,            // move accel
    friction: 0.89,        // movement friction
    maxSpeed: 16.0,        // top speed
    recoilVel: 0.55,       // pushback when firing
    recoilAimKick: 0.015,  // tiny aim wobble
    bulletSpeed: 950,      // px/s
    bulletLife: 1.25,      // seconds
    trailEvery: 0.016,     // seconds between trail samples
    barrelLen: 26,
    aimSmooth: 9.5,        // higher = smoother rotation
    aimGamma: 1.25,        // stick curve
    camShake: 0.6,         // impact shake
    hitPause: 60,          // ms
    knockback: 280,        // enemy knockback
  };

  // ---------- Weapon System ----------
  const WEAPON = {
    mode: 'AUTO',                 // SEMI | AUTO | BURST
    rpm: { SEMI: 420, AUTO: 720, BURST: 900 },
    burstSize: 3,
    burstGapMs: 24
  };
  const gun = { cooldownMs: 0, burstLeft: 0, lastFireHeld: false };
  const msPerShot = (m) => 60000 / WEAPON.rpm[m];

  // ---------- World ----------
  const world = {
    timeFreezeUntil: 0,
    shake: 0,
    obstacles: [
      {x: 520, y: 300, w: 180, h: 80},
      {x: 1040, y: 420, w: 140, h: 140},
      {x: 1380, y: 220, w: 90,  h: 300}
    ]
  };

  // ---------- Player / Entities ----------
  const player = {
    x: 1100, y: 220,
    vx: 0, vy: 0,
    r: 18,
    rot: 0, rotTarget: 0, aimKick: 0,
  };

  const enemy = { x: 1280, y: 255, w: 90, h: 70, hp: 10, vx: 0, vy: 0 };

  const bullets = [];
  const sparks  = [];

  // ---------- Input ----------
  const keys = Object.create(null);
  let precise = false; // LT/L2 or Shift
  let gpOK = false;

  addEventListener('keydown', e => { keys[e.code] = true; });
  addEventListener('keyup',   e => { keys[e.code] = false; });

  const dead = (v) => (Math.abs(v) < 0.13 ? 0 : v);
  const curve = (v, g) => Math.sign(v) * Math.pow(Math.abs(v), g);

  let modeToggleLatch = false;

  const input = { lx:0, ly:0, rx:0, ry:0, fire:false };

  function cycleMode(){
    WEAPON.mode = (WEAPON.mode==='SEMI') ? 'AUTO' : (WEAPON.mode==='AUTO' ? 'BURST' : 'SEMI');
    gun.burstLeft = 0; gun.cooldownMs = 0;
  }

  function pollPad() {
    const gp = navigator.getGamepads?.()[0];
    if (!gp) {
      gpOK = false;
      input.lx = (keys['KeyD']?1:0) - (keys['KeyA']?1:0);
      input.ly = (keys['KeyS']?1:0) - (keys['KeyW']?1:0);
      input.rx = 0; input.ry = 0;
      input.fire = !!keys['Space'];
      precise = !!(keys['ShiftLeft']||keys['ShiftRight']);
      const wantToggle = !!keys['KeyF'];
      if (wantToggle && !modeToggleLatch) cycleMode();
      modeToggleLatch = wantToggle;
      return;
    }
    gpOK = true;
    input.lx = dead(gp.axes[0]);
    input.ly = dead(gp.axes[1]);
    input.rx = curve(dead(gp.axes[2]), CFG.aimGamma);
    input.ry = curve(dead(gp.axes[3]), CFG.aimGamma);
    input.fire = !!gp.buttons?.[7]?.pressed || !!keys['Space']; // RT/Space
    precise   = !!gp.buttons?.[6]?.pressed;                      // LT/L2
    const wantToggle = !!gp.buttons?.[3]?.pressed || !!keys['KeyF']; // Y/Triangle or F
    if (wantToggle && !modeToggleLatch) cycleMode();
    modeToggleLatch = wantToggle;
  }

  // ---------- Helpers ----------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const len2 = (x, y) => x*x + y*y;
  const sign = Math.sign;

  function angleLerp(a, b, t){
    let d = (b - a + Math.PI*3) % (Math.PI*2) - Math.PI;
    return a + d * t;
  }

  function rectContains(r, x, y){ return x>=r.x && x<=r.x+r.w && y>=r.y && y<=r.y+r.h; }

  // circle vs aabb resolution (simple push-out)
  function resolveCircleRect(px, py, pr, r){
    const cx = clamp(px, r.x, r.x + r.w);
    const cy = clamp(py, r.y, r.y + r.h);
    let dx = px - cx, dy = py - cy;
    const d2 = dx*dx + dy*dy;
    const rr = pr*pr;
    if (d2 < rr) {
      const d = Math.max(0.0001, Math.sqrt(d2));
      const nx = dx / d, ny = dy / d;
      const pen = pr - d;
      return { hit: true, nx, ny, pen };
    }
    return { hit: false };
  }

  // ---------- Update / Physics ----------
  let last = performance.now()/1000;
  let trailAcc = 0;

  function step() {
    const now = performance.now()/1000;
    let dt = Math.min(0.033, now - last);
    last = now;

    pollPad();

    // slowdown on hit-pause
    const nowMs = performance.now();
    const frozen = nowMs < world.timeFreezeUntil;
    if (frozen) dt *= 0.25;

    // Movement input
    const mvx = input.lx, mvy = input.ly;
    const mag2 = len2(mvx, mvy);
    if (mag2 > 0) {
      // normalized, accel
      const mag = Math.sqrt(mag2);
      const nx = mvx / mag, ny = mvy / mag;
      player.vx += nx * CFG.accel * (precise ? 0.6 : 1.0);
      player.vy += ny * CFG.accel * (precise ? 0.6 : 1.0);
    }

    // Friction + speed clamp
    player.vx *= CFG.friction; player.vy *= CFG.friction;
    const sp = Math.hypot(player.vx, player.vy);
    const maxS = CFG.maxSpeed * (precise ? 0.65 : 1);
    if (sp > maxS) {
      player.vx = player.vx / sp * maxS;
      player.vy = player.vy / sp * maxS;
    }

    // Integrate
    player.x += player.vx;
    player.y += player.vy;

    // Collide with obstacles (two passes reduces jitter)
    for (let pass=0; pass<2; pass++){
      for (const o of world.obstacles){
        const res = resolveCircleRect(player.x, player.y, player.r, o);
        if (res.hit){
          player.x += res.nx * res.pen;
          player.y += res.ny * res.pen;
          // slide: zero normal velocity
          const vn = player.vx*res.nx + player.vy*res.ny;
          if (vn < 0){ player.vx -= vn*res.nx; player.vy -= vn*res.ny; }
        }
      }
    }

    // Aim target from right stick (don’t snap; smooth)
    if (Math.abs(input.rx) > 0.02 || Math.abs(input.ry) > 0.02) {
      player.rotTarget = Math.atan2(input.ry, input.rx);
    }
    const aimT = 1 - Math.exp(-CFG.aimSmooth * dt * (precise?0.6:1));
    player.rot = angleLerp(player.rot, player.rotTarget + player.aimKick, aimT);
    // decay temporary aim kick
    player.aimKick *= 0.85;

    // Firing logic (modes)
    gun.cooldownMs = Math.max(0, gun.cooldownMs - dt*1000);
    const fireHeld = !!input.fire;
    const firePressed = fireHeld && !gun.lastFireHeld;
    gun.lastFireHeld = fireHeld;

    const wantShot = (() => {
      if (WEAPON.mode === 'SEMI') return firePressed;
      if (WEAPON.mode === 'AUTO') return fireHeld;
      if (firePressed) gun.burstLeft = WEAPON.burstSize;
      return gun.burstLeft > 0;
    })();

    if (wantShot && gun.cooldownMs<=0 && !frozen) {
      const len = CFG.barrelLen * (precise ? 1.12 : 1.0);
      const bx = player.x + Math.cos(player.rot)*len;
      const by = player.y + Math.sin(player.rot)*len;
      const spx = Math.cos(player.rot)*CFG.bulletSpeed;
      const spy = Math.sin(player.rot)*CFG.bulletSpeed;
      bullets.push({x:bx,y:by,vx:spx,vy:spy, life:CFG.bulletLife, acc:0, trail:[{x:bx,y:by}]});

      // grounded recoil
      player.vx -= Math.cos(player.rot)*CFG.recoilVel;
      player.vy -= Math.sin(player.rot)*CFG.recoilVel;
      player.aimKick += (Math.random()*2-1)*0.01 + CFG.recoilAimKick;

      // cadence
      gun.cooldownMs = msPerShot(WEAPON.mode);
      if (WEAPON.mode === 'BURST') {
        gun.burstLeft--;
        if (gun.burstLeft>0) gun.cooldownMs = Math.max(gun.cooldownMs*0.35, WEAPON.burstGapMs);
      }
    }

    // Bullets
    for (let i=bullets.length-1; i>=0; i--){
      const b = bullets[i];
      const step = dt;
      b.x += b.vx * step;
      b.y += b.vy * step;
      b.life -= step;
      b.acc += step;
      if (b.acc >= CFG.trailEvery){
        b.acc = 0;
        b.trail.push({x:b.x, y:b.y});
        if (b.trail.length > 14) b.trail.shift();
      }

      // hit obstacles
      let hitSomething = false;
      for (const o of world.obstacles){
        if (rectContains({x:o.x-2,y:o.y-2,w:o.w+4,h:o.h+4}, b.x, b.y)){ hitSomething = true; break; }
      }

      // enemy hit
      if (!hitSomething && rectContains({x:enemy.x,y:enemy.y,w:enemy.w,h:enemy.h}, b.x, b.y)){
        hitSomething = true;
        enemy.hp = Math.max(0, enemy.hp-1);
        // knockback
        const kb = CFG.knockback;
        const ang = Math.atan2(b.vy, b.vx);
        enemy.vx += Math.cos(ang)* (kb*dt);
        enemy.vy += Math.sin(ang)* (kb*dt);
        // hit sparks
        for (let s=0;s<10;s++){
          const a = ang + (Math.random()*0.6 - 0.3) + Math.PI;
          const spd = 80 + Math.random()*220;
          sparks.push({x:b.x,y:b.y,vx:Math.cos(a)*spd, vy:Math.sin(a)*spd, life:0.25+Math.random()*0.25});
        }
        // hit pause + camera shake
        world.timeFreezeUntil = performance.now() + CFG.hitPause;
        world.shake = CFG.camShake;
      }

      if (hitSomething || b.life <= 0) {
        bullets.splice(i,1);
      }
    }

    // enemy integrate/drag
    enemy.vx *= 0.92; enemy.vy *= 0.92;
    enemy.x += enemy.vx * dt; enemy.y += enemy.vy * dt;

    // sparks
    for (let i=sparks.length-1;i>=0;i--){
      const s = sparks[i];
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= 0.9; s.vy *= 0.9;
      s.life -= dt;
      if (s.life<=0) sparks.splice(i,1);
    }

    // camera shake decay
    world.shake *= 0.88;

    render(dt);
    requestAnimationFrame(step);
  }

  // ---------- Render ----------
  function render(dt){
    // Background checker
    ctx.fillStyle = '#0c1420';
    ctx.fillRect(0,0,canvas.width,canvas.height);
    const cell = CFG.grid;
    const cols = Math.ceil(canvas.width / cell)+2;
    const rows = Math.ceil(canvas.height / cell)+2;
    ctx.save();
    ctx.globalAlpha = 0.18;
    for (let y=0;y<rows;y++){
      for (let x=0;x<cols;x++){
        if ((x+y)%2===0){
          ctx.fillStyle='#101a28';
          ctx.fillRect(x*cell, y*cell, cell, cell);
        }
      }
    }
    ctx.restore();

    // slight screen shake
    const sx = (Math.random()*2-1)*world.shake;
    const sy = (Math.random()*2-1)*world.shake;
    ctx.save();
    ctx.translate(sx, sy);

    // obstacles
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 2;
    for (const o of world.obstacles){
      ctx.fillStyle = 'rgba(62,75,93,0.35)';
      ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.strokeRect(o.x+0.5, o.y+0.5, o.w-1, o.h-1);
    }

    // enemy
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.strokeRect(enemy.x+0.5, enemy.y+0.5, enemy.w-1, enemy.h-1);
    // HP pips
    const pips = enemy.hp;
    const pipW = 12, gap=5, top = enemy.y-14;
    for (let i=0;i<pips;i++){
      ctx.fillStyle = 'rgba(255,95,95,0.9)';
      ctx.fillRect(enemy.x + i*(pipW+gap), top, 8, 4);
    }
    ctx.restore();

    // bullet trails
    for (const b of bullets){
      if (b.trail.length>1){
        ctx.lineWidth = 3;
        const grad = ctx.createLinearGradient(b.trail[0].x, b.trail[0].y, b.x, b.y);
        grad.addColorStop(0, 'rgba(140,180,255,0.0)');
        grad.addColorStop(1, 'rgba(140,180,255,0.9)');
        ctx.strokeStyle = grad;
        ctx.beginPath();
        ctx.moveTo(b.trail[0].x, b.trail[0].y);
        for (let i=1;i<b.trail.length;i++) ctx.lineTo(b.trail[i].x, b.trail[i].y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        // muzzle dot
        ctx.fillStyle='rgba(190,210,255,0.9)';
        ctx.beginPath(); ctx.arc(b.x, b.y, 3, 0, Math.PI*2); ctx.fill();
      }
    }

    // sparks
    for (const s of sparks){
      const a = clamp(s.life*4, 0, 1);
      ctx.fillStyle = `rgba(255,220,160,${a})`;
      ctx.fillRect(s.x, s.y, 2, 2);
    }

    // player (body + barrel)
    // zoom for precision view
    const zoom = precise ? 1.12 : 1.0;
    if (zoom !== 1) { ctx.scale(zoom, zoom); ctx.translate(-canvas.width*(zoom-1)/(2*zoom), -canvas.height*(zoom-1)/(2*zoom)); }

    ctx.fillStyle = '#e7ecf7';
    ctx.beginPath();
    ctx.arc(player.x, player.y, player.r, 0, Math.PI*2);
    ctx.fill();

    // barrel
    const bl = CFG.barrelLen;
    ctx.strokeStyle = '#6da3ff';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(player.x, player.y);
    ctx.lineTo(player.x + Math.cos(player.rot)*bl, player.y + Math.sin(player.rot)*bl);
    ctx.stroke();

    ctx.restore(); // end shake / zoom

    // HUD (top-left panel)
    const pad = 10;
    const hudX = pad, hudY = pad, hudW = 170, hudH = 46;
    ctx.fillStyle = 'rgba(10,14,22,0.65)';
    ctx.fillRect(hudX, hudY, hudW, hudH);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.strokeRect(hudX+0.5, hudY+0.5, hudW-1, hudH-1);
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto';
    ctx.textAlign='left'; ctx.textBaseline='top';
    ctx.fillText(gpOK ? 'Controller OK' : 'Controller ?', hudX+8, hudY+6);
    ctx.fillText(`Mode: ${WEAPON.mode}`, hudX+8, hudY+24);
  }

  requestAnimationFrame(step);
})();