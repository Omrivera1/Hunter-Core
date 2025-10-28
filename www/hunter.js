/* HUNTER-CORE: safe boot + minimal loop + move/aim/shoot */

(function(){
  // ---------- Canvas ----------
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const hud = document.getElementById('hud');
  const hud2 = document.getElementById('hud2');
  let DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

  function resize(){
    const w = Math.floor(innerWidth  * DPR);
    const h = Math.floor(innerHeight * DPR);
    canvas.width = w; canvas.height = h;
    canvas.style.width = '100vw';
    canvas.style.height = '100vh';
    ctx.setTransform(DPR,0,0,DPR,0,0);
  }
  addEventListener('resize', resize);

  // ---------- World ----------
  const world = {
    friction: 0.90,
    grid: 64,
    walls: [
      // x,y,w,h
      {x: innerWidth*0.65, y: innerHeight*0.60, w: 120, h: 80},
      {x: innerWidth*0.20, y: innerHeight*0.50, w: 160, h: 60},
      {x: innerWidth*0.85, y: innerHeight*0.35, w: 70,  h: 280},
    ]
  };

  // ---------- Player ----------
  const player = {
    x: innerWidth*0.6, y: innerHeight*0.4,
    vx:0, vy:0,
    r: 18,
    moveAccel: 1400,     // movement acceleration
    maxSpeed: 380,       // movement speed cap
    aim: 0,              // radians
    aimTarget: 0,
    aimLerp: 0.15,       // lower = slower rotation
    fireCooldown: 0,
    semi: true           // semi-auto default
  };

  // ---------- Bullets ----------
  const bullets = [];
  function shoot(){
    if (player.fireCooldown>0) return;
    const speed = 1100;          // fast travel
    const life  = 0.9;           // seconds visible
    const cos = Math.cos(player.aim), sin = Math.sin(player.aim);
    const px = player.x + cos*player.r;
    const py = player.y + sin*player.r;
    bullets.push({x:px, y:py, vx:cos*speed, vy:sin*speed, t:0, life});
    // recoil: small grounded push
    player.vx -= cos * 90;
    player.vy -= sin * 90;
    player.fireCooldown = player.semi ? 0.12 : 0.05;
  }

  // ---------- Input (KB + Pad) ----------
  const keys = new Set();
  addEventListener('keydown', e => { keys.add(e.key.toLowerCase()); if (e.key===' ') shoot(); });
  addEventListener('keyup',   e => keys.delete(e.key.toLowerCase()));

  let padIndex = -1;
  function getPad(){
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i=0;i<pads.length;i++){
      if (pads[i]) { padIndex = i; return pads[i]; }
    }
    padIndex = -1; return null;
  }
  const DZ = 0.18;
  const clampDZ = v => Math.abs(v) < DZ ? 0 : v;

  // ---------- Collision (AABB vs circle, simple) ----------
  function collideWalls(nx, ny){
    const r = player.r;
    for (const w of world.walls){
      const left=w.x, top=w.y, right=w.x+w.w, bottom=w.y+w.h;
      const x = Math.max(left, Math.min(nx, right));
      const y = Math.max(top,  Math.min(ny, bottom));
      const dx = nx - x, dy = ny - y;
      if (dx*dx+dy*dy <= r*r){
        // push out along smallest axis
        const overX = Math.min(Math.abs(nx-left), Math.abs(nx-right));
        const overY = Math.min(Math.abs(ny-top),  Math.abs(ny-bottom));
        if (overX < overY) nx = (nx < (left+right)/2) ? left - r : right + r;
        else               ny = (ny < (top+bottom)/2) ? top  - r : bottom + r;
      }
    }
    return {x:nx,y:ny};
  }

  // ---------- Loop ----------
  let last = 0;
  function step(ts){
    requestAnimationFrame(step);
    const dt = Math.min(0.033, (ts - last)/1000 || 0.016);
    last = ts;

    // Input: keyboard
    let ax = 0, ay = 0;
    if (keys.has('w') || keys.has('arrowup'))    ay -= 1;
    if (keys.has('s') || keys.has('arrowdown'))  ay += 1;
    if (keys.has('a') || keys.has('arrowleft'))  ax -= 1;
    if (keys.has('d') || keys.has('arrowright')) ax += 1;

    // Input: gamepad
    const gp = getPad();
    if (gp){
      hud.textContent = `Controller ✅\nMode: AUTO`;
      const lx = clampDZ(gp.axes[0]||0);
      const ly = clampDZ(gp.axes[1]||0);
      ax += lx; ay += ly;

      const rx = clampDZ(gp.axes[2]||0);
      const ry = clampDZ(gp.axes[3]||0);
      if (rx!==0 || ry!==0){
        player.aimTarget = Math.atan2(ry, rx);
      }
      // Fire: R2 or A
      const firePressed = (gp.buttons[7] && gp.buttons[7].pressed) || (gp.buttons[0] && gp.buttons[0].pressed);
      if (firePressed && !player.semi) shoot();
      // Semi-auto on tap of A when in semi mode
      if (firePressed && player.semi) { shoot(); }
      // Toggle semi/auto with Y
      if (gp.buttons[3] && gp.buttons[3].pressed && !toggleLock){ player.semi = !player.semi; toggleLock = true; }
      if (gp.buttons[3] && !gp.buttons[3].pressed) toggleLock = false;
    } else {
      hud.textContent = `Controller ?\nMode: AUTO`;
    }
    // Normalize move
    if (ax||ay){ const m=Math.hypot(ax,ay); ax/=m; ay/=m; }
    // Accelerate & speed cap
    player.vx += ax * player.moveAccel * dt;
    player.vy += ay * player.moveAccel * dt;
    const speed = Math.hypot(player.vx, player.vy);
    if (speed > player.maxSpeed){
      const s = player.maxSpeed / speed;
      player.vx *= s; player.vy *= s;
    }
    // Friction
    player.vx *= world.friction;
    player.vy *= world.friction;

    // Integrate
    let nx = player.x + player.vx * dt;
    let ny = player.y + player.vy * dt;

    // Contain to screen (soft)
    const pad = player.r+2;
    nx = Math.max(pad, Math.min(innerWidth -pad, nx));
    ny = Math.max(pad, Math.min(innerHeight-pad, ny));

    // Walls collision
    const p2 = collideWalls(nx,ny);
    player.x = p2.x; player.y = p2.y;

    // Smooth aim
    const ang = player.aim;
    let diff = ((player.aimTarget - ang + Math.PI*3) % (Math.PI*2)) - Math.PI;
    player.aim += diff * player.aimLerp;

    // Bullets
    for (let i=bullets.length-1;i>=0;i--){
      const b = bullets[i];
      b.t += dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.t > b.life) bullets.splice(i,1);
    }
    if (player.fireCooldown>0) player.fireCooldown -= dt;

    // ---------- Draw ----------
    ctx.clearRect(0,0,innerWidth,innerHeight);

    // grid background
    const g= world.grid;
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = '#0f1620';
    ctx.fillRect(0,0,innerWidth,innerHeight);
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = '#1a2330';
    for (let y=0;y<innerHeight;y+=g){
      for (let x= (y/g)%2?0:g/2; x<innerWidth; x+=g){
        ctx.fillRect(x,y,g/2,g/2);
      }
    }
    ctx.globalAlpha = 1;

    // walls
    ctx.strokeStyle='#6b7688'; ctx.fillStyle='#2a3646aa';
    for(const w of world.walls){
      ctx.fillRect(w.x,w.y,w.w,w.h);
      ctx.strokeRect(w.x+0.5,w.y+0.5,w.w-1,w.h-1);
    }

    // bullet trails (single streak, not multi-ghost)
    ctx.lineWidth = 3;
    for (const b of bullets){
      const lifeT = 1 - (b.t / b.life);
      const tx = b.x - b.vx * 0.05; // short streak
      const ty = b.y - b.vy * 0.05;
      ctx.strokeStyle = `rgba(100,155,255,${0.35 + 0.45*lifeT})`;
      ctx.beginPath(); ctx.moveTo(tx,ty); ctx.lineTo(b.x,b.y); ctx.stroke();

      ctx.fillStyle = `rgba(160,200,255,${0.6 + 0.4*lifeT})`;
      ctx.beginPath(); ctx.arc(b.x,b.y,3.5,0,Math.PI*2); ctx.fill();
    }

    // player
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.rotate(player.aim);
    // body
    ctx.fillStyle = '#e9eefb'; ctx.strokeStyle='#9fb1cc';
    ctx.beginPath(); ctx.arc(0,0,player.r,0,Math.PI*2); ctx.fill();
    // barrel
    ctx.lineWidth = 6; ctx.strokeStyle = '#7fb0ff';
    ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(player.r+16,0); ctx.stroke();
    ctx.restore();

    hud2.textContent = (gp?'Controller OK':'Controller ?') + (player.semi?'  •  Fire: SEMI':'  •  Fire: AUTO');
  }

  // ---------- Safe Boot ----------
  let toggleLock = false;
  function init(){
    try {
      resize();
      // Reset a fresh player position each boot
      player.x = innerWidth*0.60;
      player.y = innerHeight*0.40;
      player.vx = player.vy = 0;
      player.aim = 0; player.aimTarget = 0;

      // Tap anywhere to shoot (mobile test)
      canvas.addEventListener('pointerdown', e=>{
        // tap on left half toggles fire mode, right half shoots once
        if (e.clientX < innerWidth*0.25) player.semi = !player.semi;
        else shoot();
      });

      requestAnimationFrame(step);
    } catch (err){
      hud2.textContent = 'BOOT ERROR: '+err.message;
      console.error(err);
    }
  }

  window.addEventListener('load', init);
})();