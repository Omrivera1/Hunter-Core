/* HUNTER-CORE r1: movement physics + aim + bullet scaffold */

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', { alpha:false });
function resize(){ canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio; }
addEventListener('resize', resize, {passive:true}); resize();
ctx.scale(devicePixelRatio, devicePixelRatio);

// ------- WORLD ----------
const world = {
  grid: 48,
  friction: 0.88,        // velocity decay each frame (0..1)
  accel: 0.85,           // how hard we accelerate
  maxSpeed: 7.2,         // clamp top speed
  bulletSpeed: 18,
  bulletCooldownMs: 120, // basic fire rate
  bullets: [],
};

// ------- PLAYER ----------
const player = {
  x: innerWidth/2, y: innerHeight/2,
  vx: 0, vy: 0,
  r: 14,
  rot: 0,         // radians
  lastShot: 0,
};

// ------- INPUT (keyboard + gamepad + touch twin-stick) ----------
const input = { lx:0, ly:0, rx:0, ry:0, fire:false };

// Keyboard (WASD / arrows, space to fire)
const keys = {};
addEventListener('keydown', e=>{ keys[e.code]=true; if(e.code==='Space') input.fire=true; });
addEventListener('keyup',   e=>{ keys[e.code]=false; if(e.code==='Space') input.fire=false; });

// Touch twin-stick (left-half move, right-half aim)
let touchMoveId=null, touchAimId=null, touchStartPos={};
addEventListener('touchstart', e=>{
  for(const t of e.changedTouches){
    if(t.clientX < innerWidth*0.45 && touchMoveId===null){ touchMoveId=t.identifier; touchStartPos[t.identifier]=[t.clientX,t.clientY]; }
    else if(t.clientX > innerWidth*0.55 && touchAimId===null){ touchAimId=t.identifier; touchStartPos[t.identifier]=[t.clientX,t.clientY]; }
  }
},{passive:true});
addEventListener('touchmove', e=>{
  for(const t of e.changedTouches){
    if(t.identifier===touchMoveId){
      const [sx,sy]=touchStartPos[t.identifier]; const dx=t.clientX-sx, dy=t.clientY-sy;
      const len=Math.hypot(dx,dy)||1; let nx=dx/len, ny=dy/len;
      const dead=10; if(Math.hypot(dx,dy)<dead){ nx=0; ny=0; }
      input.lx = clamp(nx,-1,1); input.ly = clamp(ny,-1,1);
    }
    if(t.identifier===touchAimId){
      const [sx,sy]=touchStartPos[t.identifier]; const dx=t.clientX-sx, dy=t.clientY-sy;
      const len=Math.hypot(dx,dy)||1; let nx=dx/len, ny=dy/len;
      const dead=8; if(Math.hypot(dx,dy)<dead){ nx=0; ny=0; }
      input.rx = clamp(nx,-1,1); input.ry = clamp(ny,-1,1);
      input.fire = (Math.hypot(dx,dy) > 40); // simple “press” when pushing far
    }
  }
},{passive:true});
addEventListener('touchend', e=>{
  for(const t of e.changedTouches){
    if(t.identifier===touchMoveId){ touchMoveId=null; input.lx=0; input.ly=0; }
    if(t.identifier===touchAimId){ touchAimId=null; input.rx=0; input.ry=0; input.fire=false; }
    delete touchStartPos[t.identifier];
  }
},{passive:true});

// Gamepad
function pollGamepad(){
  const gp = navigator.getGamepads?.()[0];
  if(!gp) return;
  const lx = dead(gp.axes[0]), ly = dead(gp.axes[1]);
  const rx = dead(gp.axes[2]), ry = dead(gp.axes[3]);
  input.lx = lx; input.ly = ly;
  input.rx = rx; input.ry = ry;
  input.fire = gp.buttons?.[7]?.pressed || keys['Space'] || input.fire;
}
function dead(v){ const d=0.14; return Math.abs(v) < d ? 0 : v; }
function clamp(v,min,max){ return Math.max(min, Math.min(max,v)); }

// ------- UPDATE LOOP ----------
let last = performance.now();
function step(now){
  requestAnimationFrame(step);
  const dt = (now-last)/16.66; last = now;
  pollGamepad();

  const kmx = (keys['KeyA']||keys['ArrowLeft']?-1:0) + (keys['KeyD']||keys['ArrowRight']?1:0);
  const kmy = (keys['KeyW']||keys['ArrowUp']?-1:0) + (keys['KeyS']||keys['ArrowDown']?1:0);

  const mx = kmx || input.lx;
  const my = kmy || input.ly;

  player.vx += mx * world.accel;
  player.vy += my * world.accel;
  player.vx *= world.friction;
  player.vy *= world.friction;

  const sp = Math.hypot(player.vx, player.vy);
  if(sp > world.maxSpeed){
    const k = world.maxSpeed / sp;
    player.vx *= k; player.vy *= k;
  }

  player.x += player.vx; player.y += player.vy;

  const ax = input.rx || 0, ay = input.ry || 0;
  if(Math.abs(ax)+Math.abs(ay) > 0.001){
    player.rot = Math.atan2(ay, ax);
  } else if(sp > 0.1){
    player.rot = Math.atan2(player.vy, player.vy);
  }

  draw();
}
requestAnimationFrame(step);

// ------- DRAW ----------
function draw(){
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0,0,canvas.width/devicePixelRatio,canvas.height/devicePixelRatio);
  ctx.save();ctx.translate(player.x,player.y);ctx.rotate(player.rot);
  ctx.fillStyle='#e7ecf2';ctx.beginPath();ctx.arc(0,0,14,0,Math.PI*2);ctx.fill();
  ctx.strokeStyle='#87a6ff';ctx.lineWidth=3;
  ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(24,0);ctx.stroke();
  ctx.restore();
}