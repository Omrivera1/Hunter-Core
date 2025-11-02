/* HUNTER-CORE r20
   - Camera scrolling (large world)
   - Obstacles variety; subtle neon-noir grid
   - Enemies: simple "zombie" wanderers (later: chase mode)
   - L1 toggles fire mode: AUTO → SEMI → BURST → SHOTGUN
   - Realistic shot look: brief white-hot core + orange tracer + JW sparks
   - Muzzle flash; recoil clamped (never beats movement)
   - Smooth aim; L3 sprint
*/

(() => {
  // ---------- Canvas ----------
  const canvas = document.getElementById('c') || (() => {
    const el = document.createElement('canvas'); el.id='c'; document.body.appendChild(el); return el;
  })();
  const ctx = canvas.getContext('2d', { alpha: false });

  const DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  function resize() {
    const w = innerWidth, h = innerHeight;
    canvas.width = Math.floor(w*DPR); canvas.height = Math.floor(h*DPR);
    canvas.style.width = w+'px'; canvas.style.height = h+'px';
    ctx.setTransform(DPR,0,0,DPR,0,0);
  }
  addEventListener('resize', resize); resize();

  // ---------- Palette ----------
  const PAL = {
    bgA:'#0e1522', bgB:'#111a2a',
    gridA:'rgba(255,255,255,0.03)', gridB:'rgba(255,255,255,0.015)',
    player:'#e6eefc', playerEdge:'#91a8ff',
    barrel:'#d7e1ff',
    muzzle:'#ffe6ad',
    tracerHot:'#ffd7a1',  // near-white/amber
    tracerFade:'rgba(255,140,40,0.0)', // tail fade
    sparkHot:'#ffd48a', sparkCool:'#ff7a52',
    enemy:'#495569', enemyEdge:'#a7d7ff',
    hud:'rgba(255,255,255,0.6)'
  };

  // ---------- World & Camera ----------
  const world = {
    W: 3600, H: 2400,          // big scrolling arena
    grid: 64,
    boundsPad: 64,
    friction: 8,
    accel: 1000,
    baseSpeed: 320,
    sprintMult: 1.55,
    recoilPush: 120,
    // hand-made obstacle palette (rects + pillars)
    obstacles: []
  };

  // Build some varied obstacles
  (function buildObstacles() {
    // rectangles
    const rect = (x,y,w,h)=>({type:'rect',x,y,w,h});
    const pillar = (x,y,r)=>({type:'pill',x,y,r});
    world.obstacles.push(
      rect(900,  520, 260, 80),
      rect(1480, 380, 120, 360),
      rect(2100, 780, 360, 90),
      rect(2550, 400, 160, 120),
      rect(2900, 1200, 220, 100),
      rect(800,  1400, 300, 90),
      rect(1600, 1600, 500, 80),
      rect(2200, 1840, 160, 380),
      rect(400,  1900, 300, 120),
      rect(3000, 600, 90, 420),
    );
    // pillars
    world.obstacles.push(
      pillar(1200, 1000, 36),
      pillar(1750, 900, 42),
      pillar(2450, 1350, 38),
      pillar(3100, 1550, 46),
      pillar(600,  600, 32),
    );
  })();

  const camera = { x:0, y:0 }; // top-left in world coords

  // ---------- Input (Gamepad) ----------
  const PAD = { LX:0, LY:1, RX:2, RY:3, L1:4, R1:5, L2:6, R2:7, SELECT:8, START:9, L3:10, R3:11 };
  const input = {
    move:{x:0,y:0}, aim:{x:1,y:0},
    fireHeld:false, l3Held:false,
    _prevL1:false
  };

  function pad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p) return p;
    return null;
  }
  addEventListener('gamepadconnected',()=>{}); addEventListener('gamepaddisconnected',()=>{});

  function readInput() {
    const p = pad(); if (!p) { input.move.x=input.move.y=0; input.fireHeld=false; return; }
    const dead = (v,d=0.15)=>Math.abs(v)<d?0:v;

    const lx=dead(p.axes[PAD.LX]||0), ly=dead(p.axes[PAD.LY]||0);
    const rx=dead(p.axes[PAD.RX]||0), ry=dead(p.axes[PAD.RY]||0);
    input.move.x=lx; input.move.y=ly;
    if (rx||ry) { input.aim.x=rx; input.aim.y=ry; }
    input.fireHeld = (p.buttons[PAD.R2]?.value??0)>0.5 || !!p.buttons[PAD.R1]?.pressed;
    input.l3Held = !!p.buttons[PAD.L3]?.pressed;

    const l1 = !!p.buttons[PAD.L1]?.pressed;
    if (l1 && !input._prevL1) cycleFireMode();
    input._prevL1 = l1;
  }

  // ---------- Player / Enemies ----------
  const player = {
    x: world.W/2, y: world.H/2,
    vx:0, vy:0, radius:18,
    angle:0, aimSmooth:0.18
  };

  function spawnEnemies(n=7) {
    enemies.length=0;
    for (let i=0;i<n;i++) {
      enemies.push({
        x: 300 + Math.random()*(world.W-600),
        y: 300 + Math.random()*(world.H-600),
        vx:0, vy:0, w:56, h:46, friction: 11,
        hp: 60, maxHp: 60,
        // wander timer
        tw: 0, // time left on current wander vector
        wx: 0, wy: 0
      });
    }
  }
  const enemies = [];
  spawnEnemies(8);

  // ---------- Weapon / Projectiles ----------
  const weapon = {
    mode: 'auto', // 'auto' | 'semi' | 'burst' | 'shotgun'
    rpm: 650,
    burstSize: 3, burstGap: 0.06,
    semiReady: true,
    cd: 0,
    muzzleFlash: 0
  };

  function cycleFireMode() {
    const order = ['auto','semi','burst','shotgun'];
    const i = order.indexOf(weapon.mode);
    weapon.mode = order[(i+1)%order.length];
  }

  const bullets=[]; const sparks=[];

  function fireShot(dirX,dirY) {
    const speed = 1600;
    const life = 1.0;
    const bx = player.x + Math.cos(player.angle)*player.radius;
    const by = player.y + Math.sin(player.angle)*player.radius;

    bullets.push({
      x:bx,y:by, vx:dirX*speed, vy:dirY*speed,
      life, age:0, tailAge:0.06 // very short tracer
    });

    // muzzle & recoil
    weapon.muzzleFlash = 0.05;
    const recoilMag = Math.min(world.recoilPush, world.accel*0.14);
    player.vx -= dirX*recoilMag; player.vy -= dirY*recoilMag;
  }

  function shoot(dirX,dirY) {
    if (weapon.cd>0) return;

    switch(weapon.mode){
      case 'auto': fireShot(dirX,dirY); weapon.cd = 60/weapon.rpm; break;
      case 'semi':
        if (weapon.semiReady){ fireShot(dirX,dirY); weapon.semiReady=false; }
        weapon.cd = 0.08;
        break;
      case 'burst':
        if (weapon.semiReady){
          weapon.semiReady=false;
          // schedule burst pellets by stamping "burstQueue"
          burstQueue = weapon.burstSize;
          burstTimer = 0;
          burstDX = dirX; burstDY = dirY;
        }
        weapon.cd = 0.02;
        break;
      case 'shotgun': {
        const pellets = 7; // light buck
        const spread = 0.13; // radians
        for (let i=0;i<pellets;i++){
          const a = Math.atan2(dirY,dirX) + (Math.random()*2-1)*spread;
          fireShot(Math.cos(a), Math.sin(a));
        }
        weapon.cd = 0.22; // slower pump cadence
        break;
      }
    }
  }
  let burstQueue=0, burstTimer=0, burstDX=1, burstDY=0;

  // ---------- Physics helpers ----------
  function rectOverlap(ax,ay,aw,ah,bx,by,bw,bh){
    return ax<bx+bw && ax+aw>bx && ay<by+bh && ay+ah>by;
  }

  function collideCircleRect(cx,cy,r, rx,ry,rw,rh){
    const clx = Math.max(rx, Math.min(cx, rx+rw));
    const cly = Math.max(ry, Math.min(cy, ry+rh));
    const dx = cx - clx, dy = cy - cly;
    return dx*dx + dy*dy <= r*r ? {dx,dy,clx,cly} : null;
  }

  function collidePlayer() {
    // world edges
    player.x = Math.max(world.boundsPad+player.radius, Math.min(world.W-world.boundsPad-player.radius, player.x));
    player.y = Math.max(world.boundsPad+player.radius, Math.min(world.H-world.boundsPad-player.radius, player.y));
    // obstacles
    for (const o of world.obstacles){
      if (o.type==='rect'){
        const hit = collideCircleRect(player.x,player.y,player.radius, o.x,o.y,o.w,o.h);
        if (hit){
          // push out along smallest axis
          const dx = player.x - hit.clx;
          const dy = player.y - hit.cly;
          if (Math.abs(dx)>Math.abs(dy)){
            player.x = dx>0 ? o.x+o.w+player.radius : o.x-player.radius;
            player.vx = 0;
          } else {
            player.y = dy>0 ? o.y+o.h+player.radius : o.y-player.radius;
            player.vy = 0;
          }
        }
      } else { // pillar
        const dx = player.x - o.x, dy = player.y - o.y;
        const d2 = dx*dx+dy*dy, r = player.radius + o.r;
        if (d2 < r*r){
          const d = Math.sqrt(d2)||1;
          const nx=dx/d, ny=dy/d;
          player.x = o.x + nx*r; player.y = o.y + ny*r;
          // kill normal velocity
          const vn = player.vx*nx + player.vy*ny;
          if (vn<0){ player.vx -= vn*nx; player.vy -= vn*ny; }
        }
      }
    }
  }

  // ---------- Update ----------
  let last = performance.now();
  function update(dt) {
    readInput();

    // Aim smoothing
    const target = Math.atan2(input.aim.y, input.aim.x);
    let da = ((target - player.angle + Math.PI*3) % (Math.PI*2)) - Math.PI;
    player.angle += da * player.aimSmooth;

    // Desired velocity & sprint
    const im = Math.hypot(input.move.x,input.move.y);
    const mx = im ? input.move.x/im : 0, my = im ? input.move.y/im : 0;
    const speed = world.baseSpeed * (input.l3Held ? world.sprintMult : 1);
    const desiredVx = mx*speed, desiredVy = my*speed;

    // Responsive steering + friction
    player.vx += (desiredVx - player.vx) * Math.min(1, dt*10);
    player.vy += (desiredVy - player.vy) * Math.min(1, dt*10);
    const f = Math.exp(-world.friction*dt);
    player.vx *= f; player.vy *= f;

    player.x += player.vx*dt; player.y += player.vy*dt;
    collidePlayer();

    // Camera follows (centered), clamped to world
    const vw = canvas.width/DPR, vh = canvas.height/DPR;
    camera.x = Math.max(0, Math.min(world.W - vw, player.x - vw/2));
    camera.y = Math.max(0, Math.min(world.H - vh, player.y - vh/2));

    // Firing cadence (burst management)
    weapon.cd = Math.max(0, weapon.cd - dt);
    weapon.muzzleFlash = Math.max(0, weapon.muzzleFlash - dt);

    const aimLen = Math.hypot(input.aim.x,input.aim.y)||1;
    const dx = input.aim.x/aimLen, dy = input.aim.y/aimLen;
    if (weapon.mode==='semi'){
      if (!input.fireHeld) weapon.semiReady = true;
    }
    if (weapon.mode==='burst'){
      if (!input.fireHeld && burstQueue===0) weapon.semiReady = true;
      if (burstQueue>0){
        burstTimer -= dt;
        if (burstTimer<=0){
          fireShot(burstDX,burstDY);
          burstQueue--; burstTimer = weapon.burstGap;
        }
      }
    }
    if (input.fireHeld) shoot(dx,dy);

    // Bullets
    for (let i=bullets.length-1;i>=0;i--){
      const b = bullets[i];
      b.age += dt;
      b.x += b.vx*dt; b.y += b.vy*dt;

      // impacts with enemies
      for (const e of enemies){
        if (rectOverlap(b.x-2,b.y-2,4,4, e.x-e.w/2, e.y-e.h/2, e.w, e.h)){
          e.hp = Math.max(0, e.hp-10);
          e.vx += b.vx*0.02; e.vy += b.vy*0.02;
          spawnSparks(b.x,b.y, Math.atan2(b.vy,b.vx));
          bullets.splice(i,1); i--; break;
        }
      }
      // world bounds/obstacles
      if (i>=0){
        if (b.x<world.boundsPad || b.x>world.W-world.boundsPad || b.y<world.boundsPad || b.y>world.H-world.boundsPad){
          spawnSparks(b.x,b.y, Math.atan2(b.vy,b.vx)); bullets.splice(i,1); continue;
        }
        for (const o of world.obstacles){
          if (o.type==='rect'){
            if (rectOverlap(b.x-1,b.y-1,2,2, o.x,o.y,o.w,o.h)){
              spawnSparks(b.x,b.y, Math.atan2(b.vy,b.vx)); bullets.splice(i,1); break;
            }
          } else {
            const dx=b.x-o.x, dy=b.y-o.y, r=o.r+2;
            if (dx*dx+dy*dy<r*r){ spawnSparks(b.x,b.y, Math.atan2(b.vy,b.vx)); bullets.splice(i,1); }
          }
        }
      }
      if (i>=0 && b.age>1.2){ bullets.splice(i,1); }
    }

    // Enemies wander (zombie vibe)
    for (const e of enemies){
      e.tw -= dt;
      if (e.tw<=0){
        // pick new wander direction and duration
        const a = Math.random()*Math.PI*2;
        const m = 80 + Math.random()*120; // wander speed
        e.wx = Math.cos(a)*m; e.wy = Math.sin(a)*m;
        e.tw = 0.8 + Math.random()*1.2;
      }
      // apply wander accel-ish
      e.vx += (e.wx - e.vx)*Math.min(1, dt*2);
      e.vy += (e.wy - e.vy)*Math.min(1, dt*2);
      const ef = Math.exp(-e.friction*dt);
      e.vx *= ef; e.vy *= ef;
      e.x += e.vx*dt; e.y += e.vy*dt;

      // keep inside world
      e.x = Math.max(world.boundsPad+e.w/2, Math.min(world.W-world.boundsPad-e.w/2, e.x));
      e.y = Math.max(world.boundsPad+e.h/2, Math.min(world.H-world.boundsPad-e.h/2, e.y));
    }

    // Sparks
    for (let i=sparks.length-1;i>=0;i--){
      const s=sparks[i];
      s.age+=dt;
      s.vx*=0.98; s.vy = s.vy*0.98 + 600*dt*0.18;
      s.x+=s.vx*dt; s.y+=s.vy*dt;
      if (s.age>s.life) sparks.splice(i,1);
    }
  }

  function spawnSparks(x,y,angle){
    const N = 12 + (Math.random()*6|0);
    for (let i=0;i<N;i++){
      const a = angle + (Math.random()*0.8-0.4);
      const sp = 260 + Math.random()*280;
      sparks.push({ x,y, vx:Math.cos(a)*sp, vy:Math.sin(a)*sp, age:0, life:0.18+Math.random()*0.25 });
    }
  }

  // ---------- Render ----------
  function drawGrid() {
    const vw = canvas.width/DPR, vh = canvas.height/DPR;
    // background
    const g = ctx.createLinearGradient(0,0,vw,vh);
    g.addColorStop(0,PAL.bgA); g.addColorStop(1,PAL.bgB);
    ctx.fillStyle=g; ctx.fillRect(0,0,vw,vh);

    // checker aligned to world (scrolls)
    const s = world.grid;
    const startX = Math.floor(camera.x/s)*s;
    const startY = Math.floor(camera.y/s)*s;
    for (let y=startY; y<camera.y+vh; y+=s){
      for (let x=startX; x<camera.x+vw; x+=s){
        const sx = Math.floor(x/s), sy = Math.floor(y/s);
        ctx.fillStyle = ((sx+sy)&1) ? PAL.gridA : PAL.gridB;
        ctx.fillRect(Math.floor(x-camera.x), Math.floor(y-camera.y), s, s);
      }
    }
  }

  function drawObstacles(){
    ctx.lineWidth=1.5;
    for (const o of world.obstacles){
      if (o.type==='rect'){
        ctx.fillStyle='rgba(255,255,255,0.06)';
        ctx.strokeStyle='rgba(255,255,255,0.18)';
        ctx.fillRect(o.x-camera.x, o.y-camera.y, o.w, o.h);
        ctx.strokeRect(o.x-camera.x, o.y-camera.y, o.w, o.h);
      } else {
        ctx.fillStyle='rgba(255,255,255,0.06)';
        ctx.strokeStyle='rgba(255,255,255,0.18)';
        ctx.beginPath();
        ctx.arc(o.x-camera.x, o.y-camera.y, o.r, 0, Math.PI*2);
        ctx.fill(); ctx.stroke();
      }
    }
  }

  function drawPlayer(){
    // body
    ctx.beginPath();
    ctx.arc(player.x-camera.x, player.y-camera.y, player.radius, 0, Math.PI*2);
    ctx.fillStyle=PAL.player; ctx.fill();
    ctx.lineWidth=2; ctx.strokeStyle=PAL.playerEdge; ctx.stroke();

    // barrel
    const bl=28;
    ctx.strokeStyle=PAL.barrel; ctx.lineWidth=6; ctx.lineCap='round';
    ctx.beginPath();
    ctx.moveTo(player.x-camera.x, player.y-camera.y);
    ctx.lineTo(player.x-camera.x + Math.cos(player.angle)*bl, player.y-camera.y + Math.sin(player.angle)*bl);
    ctx.stroke();

    // muzzle flash
    if (weapon.muzzleFlash>0){
      const m = 10 + 10*(weapon.muzzleFlash/0.05);
      ctx.fillStyle=PAL.muzzle;
      ctx.beginPath();
      ctx.arc(player.x-camera.x + Math.cos(player.angle)*bl, player.y-camera.y + Math.sin(player.angle)*bl, m*0.5, 0, Math.PI*2);
      ctx.fill();
    }
  }

  function drawBullets(){
    for (const b of bullets){
      // tiny orange/amber tracer (very short)
      const tx = b.x - b.vx * b.tailAge;
      const ty = b.y - b.vy * b.tailAge;
      const grad = ctx.createLinearGradient(b.x-camera.x, b.y-camera.y, tx-camera.x, ty-camera.y);
      grad.addColorStop(0, PAL.tracerHot);
      grad.addColorStop(1, PAL.tracerFade);
      ctx.strokeStyle = grad; ctx.lineWidth=2; ctx.lineCap='round';
      ctx.beginPath(); ctx.moveTo(b.x-camera.x, b.y-camera.y); ctx.lineTo(tx-camera.x, ty-camera.y); ctx.stroke();

      // bright core
      ctx.fillStyle='#fff5db';
      ctx.beginPath(); ctx.arc(b.x-camera.x, b.y-camera.y, 2.1, 0, Math.PI*2); ctx.fill();
    }
  }

  function drawSparks(){
    for (const s of sparks){
      const r = 2.0*(1 - s.age/s.life);
      ctx.fillStyle = s.age < s.life*0.5 ? PAL.sparkHot : PAL.sparkCool;
      ctx.beginPath(); ctx.arc(s.x-camera.x, s.y-camera.y, Math.max(0,r), 0, Math.PI*2); ctx.fill();
    }
  }

  function drawEnemies(){
    for (const e of enemies){
      // rounded zombie-ish capsule (simple)
      const x = e.x-camera.x, y = e.y-camera.y;
      const w = e.w, h=e.h, r = 10;
      ctx.fillStyle=PAL.enemy; ctx.strokeStyle=PAL.enemyEdge; ctx.lineWidth=2;
      ctx.beginPath();
      ctx.moveTo(x-w/2+r, y-h/2);
      ctx.arcTo(x+w/2, y-h/2, x+w/2, y+h/2, r);
      ctx.arcTo(x+w/2, y+h/2, x-w/2, y+h/2, r);
      ctx.arcTo(x-w/2, y+h/2, x-w/2, y-h/2, r);
      ctx.arcTo(x-w/2, y-h/2, x+w/2, y-h/2, r);
      ctx.closePath(); ctx.fill(); ctx.stroke();

      // HP pips
      const pips = Math.ceil((e.hp/e.maxHp)*8);
      const top = y - h/2 - 10;
      for (let i=0;i<8;i++){
        ctx.fillStyle = i<pips ? '#ff6a6a' : 'rgba(255,255,255,0.15)';
        ctx.fillRect(x-48+i*12, top, 8, 4);
      }
    }
  }

  function drawHUD(){
    ctx.fillStyle=PAL.hud;
    ctx.font='14px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    ctx.fillText(`Mode: ${weapon.mode.toUpperCase()}  (L1 to toggle)`, 16, 22);
  }

  function render(){
    drawGrid();
    drawObstacles();
    drawEnemies();
    drawBullets();
    drawSparks();
    drawPlayer();
    drawHUD();
  }

  // ---------- Main Loop ----------
  function frame(now){
    const dt = Math.min(0.033, (now - last)/1000); last = now;
    update(dt); render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();