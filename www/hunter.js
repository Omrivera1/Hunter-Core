/* HUNTER-CORE r11
   - Smooth aim + precision zoom (LT/L2)
   - Curved stick response, thicker barrel, aim dot
   - Semi-auto fire with edge detection
   - Grounded recoil + clean bullet trail
*/

const CFG = {
  // movement
  friction: 0.88, accel: 0.85, maxSpeed: 7.2, grid: 48,

  // bullets / feel
  bulletSpeed: 19, impactShake: 1.6, hitPauseMs: 70,

  // AIM FEEL
  rotFollowBase: 6.0,        // slower follow
  aimFilter: 0.22,           // steadier aim vector
  aimGamma: 1.8,             // finer near center
  precisionFactor: 0.35,     // when LT/L2 held

  // camera zoom (L2)
  zoomDefault: 1.00,
  zoomPrecision: 1.30,
  zoomLerp: 0.12,

  // barrel look
  barrelLen: 28,
  barrelWidth: 7,

  // trails
  trailPoints: 6,
  trailFade: 0.22,

  // recoil (grounded)
  recoilVelocityFactor: 0.28,
  recoilAimKick: 0.07,
  aimKickDecay: 0.86,

  // tiles / physics
  tileSize: 48, substepsMax: 4, epsilon: 0.001
};

// ---------- Canvas ----------
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', { alpha:false });
function resize(){
  const dpr = devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.setTransform(1,0,0,1,0,0);
  ctx.scale(dpr, dpr);
}
addEventListener('resize', resize, {passive:true}); resize();

// ---------- Input ----------
const input = { lx:0, ly:0, rx:0, ry:0, fire:false };
const keys = {};
addEventListener('keydown', e=>{ keys[e.code]=true; });
addEventListener('keyup', e=>{ keys[e.code]=false; });

function dead(v){ const d=0.16; return Math.abs(v)<d?0:v; }
function curve(v,g){ const s=Math.sign(v), a=Math.abs(v); return s * Math.pow(a,g); }

let precisionHold = false;                 // LT / L2
let gamepadConnected = false;
addEventListener('gamepadconnected', ()=>{ gamepadConnected = true; });
addEventListener('gamepaddisconnected', ()=>{ gamepadConnected = false; });

function pollGamepad(){
  const gp = navigator.getGamepads?.()[0];
  if(!gp) { // fallback to WASD + mouse for desktop testing
    input.lx = (keys['KeyD']?1:0) - (keys['KeyA']?1:0);
    input.ly = (keys['KeyS']?1:0) - (keys['KeyW']?1:0);
    input.rx = input.ry = 0; // mouse aiming not wired here
    input.fire = !!keys['Space'];
    precisionHold = !!keys['ShiftLeft'] || !!keys['ShiftRight'];
    return;
  }
  input.lx = dead(gp.axes[0]); input.ly = dead(gp.axes[1]);
  input.rx = curve(dead(gp.axes[2]), CFG.aimGamma);
  input.ry = curve(dead(gp.axes[3]), CFG.aimGamma);
  input.fire = !!gp.buttons?.[7]?.pressed || !!keys['Space']; // RT or Space
  precisionHold = !!gp.buttons?.[6]?.pressed;                  // LT / L2
}

// ---------- World / Camera ----------
const cam = { zoom: CFG.zoomDefault, target: CFG.zoomDefault };

const player = {
  x: innerWidth/2, y: innerHeight/2,
  vx:0, vy:0,
  rot: 0, aimX: 1, aimY: 0,
  fireCooldown: 0, // ms
  lastFire: false,
};

const bullets = []; // {x,y, vx,vy, life, trail:[{x,y}]}

// simple target dummy for feel checks
const dummy = { x: innerWidth*0.66, y: innerHeight*0.45, w:42, h:32, hp: 5 };

// ---------- Utils ----------
function clamp(v,a,b){ return Math.max(a, Math.min(b,v)); }
function approach(v, target, amt){ return v + (target - v) * amt; }

// ---------- Update ----------
let last = performance.now();
function tick(){
  requestAnimationFrame(tick);
  const now = performance.now();
  let dt = (now - last) / 1000;            // seconds
  last = now;
  dt = Math.min(dt, 1/30);                 // clamp big hitches

  pollGamepad();

  // movement (left stick)
  const moveMag = Math.hypot(input.lx, input.ly);
  if (moveMag > 0){
    const ax = (input.lx/moveMag) * CFG.accel;
    const ay = (input.ly/moveMag) * CFG.accel;
    player.vx += ax;
    player.vy += ay;
  }

  // friction & speed cap
  player.vx *= CFG.friction;
  player.vy *= CFG.friction;
  const spd = Math.hypot(player.vx, player.vy);
  if (spd > CFG.maxSpeed){
    const s = CFG.maxSpeed / (spd + 1e-6);
    player.vx *= s; player.vy *= s;
  }

  player.x += player.vx;
  player.y += player.vy;

  // keep on screen
  const margin = 24;
  player.x = clamp(player.x, margin, innerWidth - margin);
  player.y = clamp(player.y, margin, innerHeight - margin);

  // ---- AIM (right stick) -----------------------------
  let ax = input.rx, ay = input.ry;
  const mag = Math.hypot(ax, ay);
  if (mag > 0.01) {
    // low-pass the aim vector
    const f = CFG.aimFilter * (precisionHold ? CFG.precisionFactor : 1.0);
    player.aimX = player.aimX*(1-f) + (ax/mag)*f;
    player.aimY = player.aimY*(1-f) + (ay/mag)*f;

    // smooth rotation towards target angle (shortest arc)
    const targ = Math.atan2(player.aimY, player.aimX);
    const base = CFG.rotFollowBase * (precisionHold ? CFG.precisionFactor : 1.0);
    let d = ((targ - player.rot + Math.PI*3) % (Math.PI*2)) - Math.PI;
    player.rot += d * (base * dt);
  }

  // camera zoom smoothing
  cam.target = precisionHold ? CFG.zoomPrecision : CFG.zoomDefault;
  cam.zoom = approach(cam.zoom, cam.target, CFG.zoomLerp);

  // ---- FIRE (semi-auto; edge detect) -----------------
  const firePressed = input.fire && !player.lastFire;
  player.lastFire = input.fire;

  if (firePressed) {
    // spawn bullet at barrel
    const len = CFG.barrelLen * (precisionHold ? 1.15 : 1.0);
    const bx = player.x + Math.cos(player.rot) * len;
    const by = player.y + Math.sin(player.rot) * len;
    const bvx = Math.cos(player.rot) * CFG.bulletSpeed;
    const bvy = Math.sin(player.rot) * CFG.bulletSpeed;

    bullets.push({
      x: bx, y: by, vx: bvx, vy: bvy, life: 1.2, // seconds
      trail: [{x:bx, y:by}]
    });

    // grounded recoil (tiny pushback opposite aim)
    player.vx -= Math.cos(player.rot) * CFG.recoilVelocityFactor;
    player.vy -= Math.sin(player.rot) * CFG.recoilVelocityFactor;
  }

  // ---- Bullets update --------------------------------
  for (let i=bullets.length-1; i>=0; i--){
    const b = bullets[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;

    // trail points (trim)
    const lastPt = b.trail[b.trail.length-1];
    const dx = b.x - lastPt.x, dy = b.y - lastPt.y;
    if (dx*dx + dy*dy > 16) { // add point each 4px
      b.trail.push({x:b.x, y:b.y});
      if (b.trail.length > CFG.trailPoints) b.trail.shift();
    }

    // simple dummy hit
    if (rectHit(dummy, b.x, b.y)){
      b.life = -1;
      dummy.hp = Math.max(0, dummy.hp - 1);
    }

    // out of bounds or life over
    if (b.life <= 0 || b.x < -40 || b.y < -40 || b.x > innerWidth+40 || b.y > innerHeight+40){
      bullets.splice(i,1);
    }
  }

  // ---- Render ----------------------------------------
  render();
}

// ---------- Collisions (simple) ----------
function rectHit(r, px, py){
  return px >= r.x-r.w/2 && px <= r.x+r.w/2 && py >= r.y-r.h/2 && py <= r.y+r.h/2;
}

// ---------- Render ----------
function render(){
  // bg
  ctx.fillStyle = '#0f1116';
  ctx.fillRect(0,0,innerWidth,innerHeight);

  // checker grid
  const s = CFG.tileSize, dark = '#141821', light = '#161b25';
  for (let y=0; y<innerHeight; y+=s){
    for (let x=0; x<innerWidth; x+=s){
      const ix = (x/s)|0, iy = (y/s)|0;
      ctx.fillStyle = ((ix+iy)&1)?dark:light;
      ctx.fillRect(x,y,s,s);
    }
  }

  // apply zoom transform
  ctx.save();
  ctx.translate(innerWidth/2, innerHeight/2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-innerWidth/2, -innerHeight/2);

  // dummy target
  ctx.strokeStyle = '#cfd7ff';
  ctx.lineWidth = 2;
  ctx.strokeRect(dummy.x-dummy.w/2, dummy.y-dummy.h/2, dummy.w, dummy.h);
  // simple "health pips"
  for (let i=0;i<dummy.hp;i++){
    ctx.fillStyle = '#ff6b6b';
    ctx.fillRect(dummy.x - 30 + i*10, dummy.y - dummy.h/2 - 12, 6, 4);
  }

  // bullets (trail first, then head)
  for (const b of bullets){
    // trail
    for (let i=1;i<b.trail.length;i++){
      const a = b.trail[i-1], c = b.trail[i];
      const t = i / b.trail.length;
      ctx.strokeStyle = `rgba(110,167,255,${(1-t)*(1-CFG.trailFade)+0.15})`;
      ctx.lineWidth = 3*(1-t)+1;
      ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(c.x,c.y); ctx.stroke();
    }
    // head
    ctx.fillStyle = '#cfe2ff';
    ctx.beginPath(); ctx.arc(b.x, b.y, 3.2, 0, Math.PI*2); ctx.fill();
  }

  // PLAYER body
  ctx.fillStyle = '#e7ebf7';
  ctx.beginPath();
  ctx.arc(player.x, player.y, 16, 0, Math.PI*2);
  ctx.fill();

  // Barrel (thicker + longer, a bit longer while precision)
  const len = CFG.barrelLen * (precisionHold ? 1.15 : 1.0);
  const bx = player.x + Math.cos(player.rot) * len;
  const by = player.y + Math.sin(player.rot) * len;

  ctx.strokeStyle = '#6ea7ff';
  ctx.lineWidth = CFG.barrelWidth;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(player.x, player.y);
  ctx.lineTo(bx, by);
  ctx.stroke();

  // Tiny reticle dot at tip
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.arc(bx, by, 2.5, 0, Math.PI*2);
  ctx.fill();

  ctx.restore();

  // controller status (tiny)
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto';
  ctx.fillText(gamepadConnected ? 'Controller OK' : 'Controller ?', 14, innerHeight-14);
}

// ---------- Boot ----------
player.x = innerWidth*0.5; player.y = innerHeight*0.5;
player.aimX = 1; player.aimY = 0; player.rot = 0;

requestAnimationFrame(tick);