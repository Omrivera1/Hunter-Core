/* HUNTER-CORE r3 (M0): decoupled aim, target dummy, bullet hits, impact flash, SFX hook */

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', { alpha:false });
function resize(){ canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio; }
addEventListener('resize', resize, {passive:true}); resize();
ctx.scale(devicePixelRatio, devicePixelRatio);

// ------- TUNING ----------
const world = {
  grid: 48,
  friction: 0.88,
  accel: 0.85,
  maxSpeed: 7.2,
  bulletSpeed: 18,
  bulletCooldownMs: 120,
  invertAimY: true,
  bullets: [],
  fx: [],            // impact flashes
};

// ------- PLAYER ----------
const player = {
  x: innerWidth/2, y: innerHeight/2,
  vx: 0, vy: 0, r: 14,
  rot: 0, lastShot: 0,
  aim: {x:1, y:0},
};

// ------- DUMMY TARGET ----------
let dummy = spawnDummy();
function spawnDummy(){
  return { x: innerWidth*0.65, y: innerHeight*0.5, w: 26, h: 32, alive: true, hp: 3 };
}

// ------- INPUT ----------
const input = { lx:0, ly:0, rx:0, ry:0, fire:false };
const keys = {};
addEventListener('keydown', e=>{ keys[e.code]=true; if(e.code==='Space') input.fire=true; });
addEventListener('keyup',   e=>{ keys[e.code]=false; if(e.code==='Space') input.fire=false; });

// Touch twin-stick
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
      const len=Math.hypot(dx,dy)||1; const dead=10;
      input.lx = Math.hypot(dx,dy)<dead ? 0 : clamp(dx/len,-1,1);
      input.ly = Math.hypot(dx,dy)<dead ? 0 : clamp(dy/len,-1,1);
    }
    if(t.identifier===touchAimId){
      const [sx,sy]=touchStartPos[t.identifier]; const dx=t.clientX-sx, dy=t.clientY-sy;
      const len=Math.hypot(dx,dy)||1; const dead=8; const mag=Math.hypot(dx,dy);
      const ny = (world.invertAimY ? -dy : dy)/len;
      input.rx = mag<dead ? 0 : clamp(dx/len,-1,1);
      input.ry = mag<dead ? 0 : clamp(ny,-1,1);
      input.fire = mag>40;
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

// Gamepad (Backbone)
function pollGamepad(){
  const gp = navigator.getGamepads?.()[0];
  if(!gp) return;
  const lx = dead(gp.axes[0]), ly = dead(gp.axes[1]);
  const rx = dead(gp.axes[2]), ryRaw = dead(gp.axes[3]);
  const ry = world.invertAimY ? -ryRaw : ryRaw;
  input.lx = lx; input.ly = ly; input.rx = rx; input.ry = ry;
  input.fire = gp.buttons?.[7]?.pressed || keys['Space'] || input.fire; // R2/Space/touch
}
function dead(v){ const d=0.14; return Math.abs(v)<d ? 0 : v; }
function clamp(v,min,max){ return Math.max(min, Math.min(max,v)); }

// ------- LOOP ----------
let last = performance.now();
requestAnimationFrame(step);
function step(now){
  requestAnimationFrame(step);
  const dt = (now-last)/16.66; last = now;
  pollGamepad();

  // keyboard mix (desktop)
  const kmx = (keys['KeyA']||keys['ArrowLeft']?-1:0) + (keys['KeyD']||keys['ArrowRight']?1:0);
  const kmy = (keys['KeyW']||keys['ArrowUp']?-1:0) + (keys['KeyS']||keys['ArrowDown']?1:0);

  const mx = kmx || input.lx, my = kmy || input.ly;

  // move
  player.vx += mx * world.accel;
  player.vy += my * world.accel;
  player.vx *= world.friction; player.vy *= world.friction;
  const sp = Math.hypot(player.vx, player.vy);
  if(sp > world.maxSpeed){ const k = world.maxSpeed/sp; player.vx*=k; player.vy*=k; }
  player.x += player.vx; player.y += player.vy;

  // aim (independent)
  if(Math.abs(input.rx)+Math.abs(input.ry) > 0.001){
    player.aim.x = input.rx; player.aim.y = input.ry;
    player.rot = Math.atan2(player.aim.y, player.aim.x);
  }

  // shoot
  if(input.fire && (now - player.lastShot) > world.bulletCooldownMs){
    player.lastShot = now;
    const bx = player.x + Math.cos(player.rot) * (player.r + 10);
    const by = player.y + Math.sin(player.rot) * (player.r + 10);
    world.bullets.push({ x:bx, y:by, vx:Math.cos(player.rot)*world.bulletSpeed, vy:Math.sin(player.rot)*world.bulletSpeed, life:90 });
    sfx('pew');
  }

  // bullets + hit detection
  for(let i=world.bullets.length-1;i>=0;i--){
    const b = world.bullets[i];
    b.x += b.vx; b.y += b.vy; if(--b.life<=0){ world.bullets.splice(i,1); continue; }
    if(dummy.alive && pointInRect(b.x,b.y, dummy)){ // hit
      world.fx.push({ x:b.x, y:b.y, t:0 });
      world.bullets.splice(i,1);
      dummy.hp -= 1; sfx('hit');
      if(dummy.hp<=0){ dummy.alive=false; setTimeout(()=>{ dummy = spawnDummy(); }, 700); }
    }
  }

  // FX
  for(let i=world.fx.length-1;i>=0;i--){
    const f=world.fx[i]; f.t+=dt; if(f.t>8) world.fx.splice(i,1);
  }

  draw();
}

// ------- UTILS ----------
function pointInRect(px,py, r){
  return px >= r.x - r.w/2 && px <= r.x + r.w/2 && py >= r.y - r.h/2 && py <= r.y + r.h/2;
}
function sfx(name){
  try{ if(window.HUNTER_AUDIO && typeof HUNTER_AUDIO.play==='function') HUNTER_AUDIO.play(name); }catch(e){}
}

// ------- RENDER ----------
function draw(){
  // bg
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0,0,canvas.width/devicePixelRatio,canvas.height/devicePixelRatio);

  // grid
  const g = world.grid;
  ctx.globalAlpha = 0.18; ctx.strokeStyle = '#3b414a'; ctx.lineWidth = 1;
  ctx.beginPath();
  for(let x=0;x<innerWidth;x+=g){ ctx.moveTo(x+.5,0); ctx.lineTo(x+.5,innerHeight); }
  for(let y=0;y<innerHeight;y+=g){ ctx.moveTo(0,y+.5); ctx.lineTo(innerWidth,y+.5); }
  ctx.stroke(); ctx.globalAlpha = 1;

  // bullets
  ctx.fillStyle = '#9ad1ff';
  for(const b of world.bullets){ ctx.beginPath(); ctx.arc(b.x,b.y,3,0,Math.PI*2); ctx.fill(); }

  // impact FX
  for(const f of world.fx){
    const a = Math.max(0, 1 - f.t/8);
    ctx.globalAlpha = a;
    ctx.strokeStyle = '#9ad1ff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(f.x,f.y, 6+f.t*1.2, 0, Math.PI*2); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // dummy
  if(dummy.alive){
    ctx.fillStyle = '#303844'; ctx.strokeStyle = '#c8ccd2'; ctx.lineWidth = 2;
    ctx.fillRect(dummy.x-dummy.w/2, dummy.y-dummy.h/2, dummy.w, dummy.h);
    ctx.strokeRect(dummy.x-dummy.w/2, dummy.y-dummy.h/2, dummy.w, dummy.h);
    // hp pips
    for(let i=0;i<dummy.hp;i++){
      ctx.fillStyle='#ff7575';
      ctx.fillRect(dummy.x - 12 + i*8, dummy.y - dummy.h/2 - 8, 6, 4);
    }
  }

  // player
  ctx.save(); ctx.translate(player.x, player.y); ctx.rotate(player.rot);
  ctx.fillStyle = '#e7ecf2'; ctx.beginPath(); ctx.arc(0,0, player.r, 0, Math.PI*2); ctx.fill();
  ctx.strokeStyle = '#87a6ff'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(player.r+10,0); ctx.stroke();
  ctx.restore();
}