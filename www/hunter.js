/* HUNTER-CORE r19
   - Faster base run + L3 sprint (hold)
   - Smooth, non-snappy aim
   - John Wick-ish shot: crisp muzzle flash + thin "laser" trail
   - Auto fire by default; semi & burst supported internally
   - Recoil tamed (never exceeds movement accel)
   - Enemies less slippery
   - Subtle neon grid + accent colors (no extra files)
*/

(() => {
  // ---------- Canvas / Setup ----------
  const canvas = document.getElementById('c') || (() => {
    const el = document.createElement('canvas');
    el.id = 'c';
    document.body.appendChild(el);
    return el;
  })();
  const ctx = canvas.getContext('2d', { alpha: false });

  const DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const state = {
    t: 0,
    dt: 0,
    last: performance.now(),
    gamepad: null,
    hasPad: false,
  };

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width  = Math.floor(w * DPR);
    canvas.height = Math.floor(h * DPR);
    canvas.style.width  = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  addEventListener('resize', resize);
  resize();

  // ---------- Palette (neon-noir) ----------
  const PAL = {
    bgA: '#0e1522',     // deep navy
    bgB: '#111a2a',
    gridA: 'rgba(255,255,255,0.03)',
    gridB: 'rgba(255,255,255,0.015)',
    player: '#e6eefc',
    playerEdge: '#91a8ff',
    barrel: '#8ab4ff',
    trail: '#7db1ff',
    muzzle: '#ffe6ad',
    sparkHot: '#ff6a6a',
    sparkCold: '#ffb86b',
    enemy: '#3e4a5f',
    enemyEdge: '#9ad4ff',
    hud: 'rgba(255,255,255,0.5)',
  };

  // ---------- Input (Gamepad) ----------
  const PAD = {
    LX: 0, LY: 1, RX: 2, RY: 3,
    BTN_A: 0, BTN_B: 1, BTN_X: 2, BTN_Y: 3,
    L1: 4, R1: 5, L2: 6, R2: 7,
    SELECT: 8, START: 9, L3: 10, R3: 11,
  };

  addEventListener('gamepadconnected', e => {
    state.hasPad = true;
    state.gamepad = navigator.getGamepads()[e.gamepad.index];
  });
  addEventListener('gamepaddisconnected', () => {
    state.hasPad = !!navigator.getGamepads()[0];
  });

  function getPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p) return p;
    return null;
  }

  const input = {
    move: { x:0, y:0 },
    aim:  { x:1, y:0 },
    fireHeld: false,
    l3Held: false,
  };

  function readInput() {
    const p = getPad();
    if (!p) { input.move.x = input.move.y = 0; return; }

    function dead(v, d=0.15) { return Math.abs(v) < d ? 0 : v; }

    const lx = dead(p.axes[PAD.LX] || 0);
    const ly = dead(p.axes[PAD.LY] || 0);
    const rx = dead(p.axes[PAD.RX] || 0);
    const ry = dead(p.axes[PAD.RY] || 0);

    input.move.x = lx;
    input.move.y = ly;

    // If right stick is idle, keep aim; else update
    if (rx !== 0 || ry !== 0) {
      input.aim.x = rx;
      input.aim.y = ry;
    }

    const r2 = p.buttons[PAD.R2]?.value ?? 0;
    input.fireHeld = r2 > 0.5 || p.buttons[PAD.R1]?.pressed;

    input.l3Held = !!p.buttons[PAD.L3]?.pressed; // Sprint when held
  }

  // ---------- World / Physics ----------
  const world = {
    grid: 64,
    friction: 8.0,          // strong damp => snappy stop
    accel: 1000,            // movement "engine"
    baseSpeed: 310,         // faster baseline
    sprintMult: 1.55,       // L3 sprint
    recoilPush: 120,        // capped by accel handling below
    boundsPad: 48,
    obstacles: [
      { x: 0.58, y: 0.62, w: 0.18, h: 0.11 },
      { x: 0.78, y: 0.28, w: 0.07, h: 0.28 },
      { x: 0.35, y: 0.43, w: 0.18, h: 0.10 },
    ],
  };

  function pxRect(r) {
    return {
      x: r.x * canvas.width / DPR,
      y: r.y * canvas.height / DPR,
      w: r.w * canvas.width / DPR,
      h: r.h * canvas.height / DPR,
    };
  }

  // ---------- Player / Enemy / Gun ----------
  const player = {
    x: canvas.width/(DPR*2), y: canvas.height/(DPR*2),
    vx:0, vy:0,
    angle: 0,
    targetAngle: 0,
    aimSmooth: 0.18,     // lower = smoother
    radius: 18,
  };

  const enemy = {
    x: canvas.width/(DPR*2) + 260,
    y: canvas.height/(DPR*2) - 20,
    w: 60, h: 46,
    vx:0, vy:0,
    friction: 12.0,        // stickier so it doesn’t skate
    hp: 100,
    maxHp: 100,
  };

  const weapon = {
    mode: 'auto',          // 'auto' | 'semi' | 'burst'
    rpm: 600,              // auto cadence
    burstSize: 3,
    burstGap: 0.06,
    semiReady: true,
    cd: 0,                 // cooldown
    muzzleFlash: 0,
  };

  const bullets = [];
  const sparks  = [];

  function shoot(dirX, dirY) {
    // Fire cadence
    if (weapon.cd > 0) return;

    const speed = 1400;           // fast JW feel
    const life  = 0.9;            // seconds
    const bx = player.x + Math.cos(player.angle)*player.radius;
    const by = player.y + Math.sin(player.angle)*player.radius;

    bullets.push({
      x: bx, y: by,
      vx: dirX * speed,
      vy: dirY * speed,
      life, age: 0,
      // trail samples
      tail: [{x:bx, y:by, a:1}],
    });

    // Muzzle flash (very brief)
    weapon.muzzleFlash = 0.05;

    // Recoil (clamped so it never beats movement accel effect)
    const recoilMag = Math.min(world.recoilPush, world.accel*0.14);
    player.vx -= dirX * recoilMag;
    player.vy -= dirY * recoilMag;

    // Cooldown
    weapon.cd = 60/weapon.rpm; // seconds per shot
  }

  // Fire controller
  let burstLeft = 0, burstTimer = 0;
  function updateFire(dt) {
    weapon.cd = Math.max(0, weapon.cd - dt);
    weapon.muzzleFlash = Math.max(0, weapon.muzzleFlash - dt);

    const aimLen = Math.hypot(input.aim.x, input.aim.y) || 1;
    const dx = input.aim.x / aimLen;
    const dy = input.aim.y / aimLen;

    switch (weapon.mode) {
      case 'auto':
        if (input.fireHeld) shoot(dx, dy);
        break;

      case 'semi':
        if (input.fireHeld && weapon.semiReady) {
          shoot(dx, dy);
          weapon.semiReady = false;
        }
        if (!input.fireHeld) weapon.semiReady = true;
        break;

      case 'burst':
        if (input.fireHeld && weapon.semiReady && burstLeft === 0) {
          burstLeft = weapon.burstSize;
          burstTimer = 0;
          weapon.semiReady = false;
        }
        if (!input.fireHeld && burstLeft === 0) weapon.semiReady = true;

        if (burstLeft > 0) {
          burstTimer -= dt;
          if (burstTimer <= 0) {
            shoot(dx, dy);
            burstLeft--;
            burstTimer = weapon.burstGap;
          }
        }
        break;
    }
  }

  // ---------- Simulation ----------
  function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  function collideWorld(obj, radius=0) {
    // Walls = screen edges minus padding
    const W = canvas.width / DPR;
    const H = canvas.height / DPR;
    const pad = world.boundsPad;

    if (obj.x < pad + radius) { obj.x = pad + radius; obj.vx = Math.max(0, obj.vx); }
    if (obj.x > W - pad - radius){ obj.x = W - pad - radius; obj.vx = Math.min(0, obj.vx); }
    if (obj.y < pad + radius) { obj.y = pad + radius; obj.vy = Math.max(0, obj.vy); }
    if (obj.y > H - pad - radius){ obj.y = H - pad - radius; obj.vy = Math.min(0, obj.vy); }

    // Static obstacles
    for (const o of world.obstacles) {
      const r = pxRect(o);
      if (rectsOverlap(obj.x-radius, obj.y-radius, radius*2, radius*2, r.x, r.y, r.w, r.h)) {
        // simple push out along smallest axis
        const cx = Math.max(r.x, Math.min(obj.x, r.x+r.w));
        const cy = Math.max(r.y, Math.min(obj.y, r.y+r.h));
        const dx = obj.x - cx;
        const dy = obj.y - cy;
        if (Math.abs(dx) > Math.abs(dy)) {
          obj.x = dx > 0 ? r.x + r.w + radius : r.x - radius;
          obj.vx = 0;
        } else {
          obj.y = dy > 0 ? r.y + r.h + radius : r.y - radius;
          obj.vy = 0;
        }
      }
    }
  }

  function update(dt) {
    readInput();

    // Aim smoothing to prevent snap
    const target = Math.atan2(input.aim.y, input.aim.x);
    // shortest angular difference
    let da = ((target - player.angle + Math.PI*3) % (Math.PI*2)) - Math.PI;
    player.angle += da * player.aimSmooth;

    // Movement: accelerate toward stick direction, with sprint on L3
    const mag = Math.min(1, Math.hypot(input.move.x, input.move.y));
    const mx = mag ? (input.move.x / Math.hypot(input.move.x, input.move.y)) : 0;
    const my = mag ? (input.move.y / Math.hypot(input.move.x, input.move.y)) : 0;

    const speed = world.baseSpeed * (input.l3Held ? world.sprintMult : 1);
    const ax = mx * world.accel;
    const ay = my * world.accel;

    // integrate
    // steer velocity toward desired using acceleration
    const desiredVx = mx * speed;
    const desiredVy = my * speed;

    // accelerate toward desired, also apply friction
    player.vx += (desiredVx - player.vx) * Math.min(1, dt * 10); // quick responsiveness
    player.vy += (desiredVy - player.vy) * Math.min(1, dt * 10);

    // base friction (small) so idle settles nicely
    const f = Math.exp(-world.friction * dt);
    player.vx *= f; player.vy *= f;

    player.x += player.vx * dt;
    player.y += player.vy * dt;

    collideWorld(player, player.radius);

    // Fire
    updateFire(dt);

    // Bullets
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.age += dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      // trail
      if (!b.tail || b.tail.length === 0) b.tail = [{x:b.x, y:b.y, a:1}];
      const last = b.tail[b.tail.length-1];
      const dx = b.x - last.x, dy = b.y - last.y;
      if (dx*dx + dy*dy > 40) { // sample spacing
        b.tail.push({ x:b.x, y:b.y, a: 1 });
        if (b.tail.length > 10) b.tail.shift();
      }
      // fade
      for (let t of b.tail) t.a *= 0.98;

      // collide with enemy
      if (rectsOverlap(b.x-2, b.y-2, 4, 4, enemy.x-enemy.w/2, enemy.y-enemy.h/2, enemy.w, enemy.h)) {
        enemy.hp = Math.max(0, enemy.hp - 8);
        enemy.vx += (b.vx)*0.02;
        enemy.vy += (b.vy)*0.02;

        spawnSparks(b.x, b.y, Math.atan2(b.vy, b.vx));
        bullets.splice(i, 1);
        continue;
      }

      // collide with obstacles or bounds
      let hit = false;
      const W = canvas.width/DPR, H = canvas.height/DPR;
      if (b.x < world.boundsPad || b.x > W - world.boundsPad ||
          b.y < world.boundsPad || b.y > H - world.boundsPad) hit = true;

      for (const o of world.obstacles) {
        const r = pxRect(o);
        if (rectsOverlap(b.x-1, b.y-1, 2, 2, r.x, r.y, r.w, r.h)) { hit = true; break; }
      }

      if (hit || b.age > b.life) {
        spawnSparks(b.x, b.y, Math.atan2(b.vy, b.vx));
        bullets.splice(i, 1);
      }
    }

    // Enemy friction & movement
    const ef = Math.exp(-enemy.friction * dt);
    enemy.vx *= ef; enemy.vy *= ef;
    enemy.x += enemy.vx * dt; enemy.y += enemy.vy * dt;

    // Keep enemy on screen
    enemy.x = Math.max(world.boundsPad+enemy.w/2, Math.min(canvas.width/DPR-world.boundsPad-enemy.w/2, enemy.x));
    enemy.y = Math.max(world.boundsPad+enemy.h/2, Math.min(canvas.height/DPR-world.boundsPad-enemy.h/2, enemy.y));

    // Sparks
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.age += dt;
      s.vx *= 0.98; s.vy = s.vy*0.98 + 600*dt*0.15; // slight fall
      s.x += s.vx * dt; s.y += s.vy * dt;
      if (s.age > s.life) sparks.splice(i, 1);
    }
  }

  function spawnSparks(x, y, angle) {
    const N = 10 + (Math.random()*6|0);
    for (let i=0;i<N;i++){
      const a = angle + (Math.random()*0.8-0.4);
      const sp = 220 + Math.random()*220;
      sparks.push({
        x, y,
        vx: Math.cos(a)*sp,
        vy: Math.sin(a)*sp,
        age: 0,
        life: 0.20 + Math.random()*0.25,
      });
    }
  }

  // ---------- Render ----------
  function drawGrid() {
    const W = canvas.width/DPR, H = canvas.height/DPR;
    ctx.fillStyle = PAL.bgA;
    ctx.fillRect(0,0,W,H);

    // subtle checker w/ gradient hue
    const g = ctx.createLinearGradient(0,0,W,H);
    g.addColorStop(0, PAL.bgA);
    g.addColorStop(1, PAL.bgB);
    ctx.fillStyle = g;
    ctx.fillRect(0,0,W,H);

    const s = world.grid;
    for (let y=0;y<H;y+=s) {
      for (let x=0;x<W;x+=s) {
        ctx.fillStyle = ((x/s + y/s) % 2 === 0) ? PAL.gridA : PAL.gridB;
        ctx.fillRect(x, y, s, s);
      }
    }
  }

  function drawPlayer() {
    // body
    ctx.beginPath();
    ctx.arc(player.x, player.y, player.radius, 0, Math.PI*2);
    ctx.fillStyle = PAL.player;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = PAL.playerEdge;
    ctx.stroke();

    // barrel (rotated line)
    const bl = 28; // visible barrel
    ctx.strokeStyle = PAL.barrel;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(player.x, player.y);
    ctx.lineTo(player.x + Math.cos(player.angle)*bl, player.y + Math.sin(player.angle)*bl);
    ctx.stroke();

    // muzzle flash (brief)
    if (weapon.muzzleFlash > 0) {
      const m = 10 + 10 * (weapon.muzzleFlash / 0.05);
      ctx.fillStyle = PAL.muzzle;
      ctx.beginPath();
      ctx.arc(player.x + Math.cos(player.angle)*bl, player.y + Math.sin(player.angle)*bl, m*0.5, 0, Math.PI*2);
      ctx.fill();
    }
  }

  function drawBullets() {
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (const b of bullets) {
      // trail line (thin, bright, slight gradient)
      const grad = ctx.createLinearGradient(b.x, b.y, b.x - b.vx*0.05, b.y - b.vy*0.05);
      grad.addColorStop(0, 'rgba(140,190,255,0.9)');
      grad.addColorStop(1, 'rgba(140,190,255,0.0)');
      ctx.strokeStyle = grad;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      // use last tail sample to extend behind
      const t = b.tail[0] || {x:b.x, y:b.y};
      ctx.lineTo(t.x, t.y);
      ctx.stroke();

      // core projectile
      ctx.fillStyle = '#cfe2ff';
      ctx.beginPath();
      ctx.arc(b.x, b.y, 2.2, 0, Math.PI*2);
      ctx.fill();
    }
  }

  function drawSparks() {
    for (const s of sparks) {
      const r = 2.0 * (1 - s.age/s.life);
      ctx.fillStyle = s.age < s.life*0.5 ? PAL.sparkHot : PAL.sparkCold;
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(0, r), 0, Math.PI*2);
      ctx.fill();
    }
  }

  function drawEnemy() {
    // body
    ctx.fillStyle = PAL.enemy;
    ctx.strokeStyle = PAL.enemyEdge;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(enemy.x - enemy.w/2, enemy.y - enemy.h/2, enemy.w, enemy.h);
    ctx.fill(); ctx.stroke();

    // HP pips (JW-style)
    const pips = Math.ceil((enemy.hp/enemy.maxHp)*8);
    const top = enemy.y - enemy.h/2 - 10;
    for (let i=0;i<8;i++){
      ctx.fillStyle = i < pips ? '#ff6a6a' : 'rgba(255,255,255,0.15)';
      ctx.fillRect(enemy.x-48 + i*12, top, 8, 4);
    }
  }

  function drawHUD() {
    ctx.fillStyle = PAL.hud;
    ctx.font = '14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText('Controller '+(state.hasPad ? 'OK' : '?'), 16, canvas.height/DPR - 18);
  }

  function render() {
    drawGrid();
    // obstacles
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1.5;
    for (const o of world.obstacles) {
      const r = pxRect(o);
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }

    drawEnemy();
    drawBullets();
    drawSparks();
    drawPlayer();
    drawHUD();
  }

  // ---------- Main Loop ----------
  function loop(now) {
    state.dt = Math.min(0.033, (now - state.last) / 1000);
    state.last = now;
    state.t += state.dt;

    update(state.dt);
    render();

    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);
})();