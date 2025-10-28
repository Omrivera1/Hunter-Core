/* HUNTER-CORE r6 — M1 Gunplay Polish
   Identity: Military Real + Wick Precision
   Adds: recoil impulse, muzzle flash (procedural), micro hit-pause, damage numbers,
         sharper impact FX, edge-trigger fire (no auto), light screenshake.
   Keeps: LEFT=move, RIGHT=aim, invert OFF.
*/

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', { alpha:false });
function resize(){ canvas.width=innerWidth*devicePixelRatio; canvas.height=innerHeight*devicePixelRatio; }
addEventListener('resize', resize, {passive:true}); resize();
ctx.scale(devicePixelRatio, devicePixelRatio);

/* ===== TUNING ===== */
const CFG = {
  friction: 0.88,
  accel: 0.85,
  maxSpeed: 7.2,
  bulletSpeed: 19,
  bulletCooldownMs: 110,     // base semiauto cadence
  grid: 48,

  // Gunfeel polish
  recoilImpulse: 2.1,        // push back per shot (units/frame)
  hitPauseMs: 70,            // micro freeze on hit
  shakeOnShot: 0.8,          // light camera shake magnitude
  shakeOnHit: 1.6,           // a bit stronger on confirmed hit
  dmgFloatUp: 26,            // how far damage text rises
  dmgLife: 500,              // ms
};
/* ================== */

const world = { bullets:[], fx:[], dmg:[], shakeT:0, shakeMag:0, timeFreezeUntil:0 };

const player = {
  x: innerWidth/2, y: innerHeight/2,
  vx:0, vy:0, r:14,
  rot:0, lastShot:0,
  aim:{x:1, y:0},
};

const input = { lx:0, ly:0, rx:0, ry:0, fire:false, prevFire:false };
const keys = {};
addEventListener('keydown', e=>{ keys[e.code]=true; if(e.code==='Space') input.fire=true; });
addEventListener('keyup',   e=>{ keys[e.code]=false; if(e.code==='Space') input.fire=false; });

/* ----- Touch (left=move, right=aim; no auto-fire) ----- */
let touchL=null, touchR=null, startPos={};
addEventListener('touchstart', e=>{
  for(const t of e.changedTouches){
    if(t.clientX < innerWidth*0.45 && touchL===null){ touchL=t.identifier; startPos[t.identifier]=[t.clientX,t.clientY]; }
    else if(t.clientX > innerWidth*0.55 && touchR===null){ touchR=t.identifier; startPos[t.identifier]=[t.clientX,t.clientY]; }
  }
},{passive:true});
addEventListener('touchmove', e=>{
  for(const t of e.changedTouches){
    const [sx,sy]=startPos[t.identifier]||[t.clientX,t.clientY];
    const dx=t.clientX-sx, dy=t.clientY-sy, len=Math.hypot(dx,dy)||1, mag=Math.hypot(dx,dy);
    if(t.identifier===touchL){ const dead=10; input.lx = mag<dead?0:dx/len; input.ly = mag<dead?0:dy/len; }
    if(t.identifier===touchR){ const dead=8;  input.rx = mag<dead?0:dx/len; input.ry = mag<dead?0:dy/len; }
  }
},{passive:true});
addEventListener('touchend', e=>{
  for(const t of e.changedTouches){
    if(t.identifier===touchL){ touchL=null; input.lx=0; input.ly=0; }
    if(t.identifier===touchR){ touchR=null; input.rx=0; input.ry=0; }
    delete startPos[t.identifier];
  }
},{passive:true});

/* ----- Gamepad ----- */
function dead(v){ const d=0.14; return Math.abs(v)<d?0:v; }
function pollGamepad(){
  const gp = navigator.getGamepads?.()[0]; if(!gp) return;
  input.lx = dead(gp.axes[0]); input.ly = dead(gp.axes[1]); // LEFT=move
  input.rx = dead(gp.axes[2]); input.ry = dead(gp.axes[3]); // RIGHT=aim
  input.fire = !!gp.buttons?.[7]?.pressed || !!keys['Space']; // R2/Space only
}

/* ----- Dummy target (for feedback) ----- */
let dummy = spawnDummy();
function spawnDummy(){ return { x:innerWidth*0.65, y:innerHeight*0.5, w:26, h:32, alive:true, hp:6 }; }
function pointInRect(px,py,r){ return px>=r.x-r.w/2 && px<=r.x+r.w/2 && py>=r.y-r.h/2 && py<=r.y+r.h/2; }

/* ----- Loop ----- */
let last = performance.now();
requestAnimationFrame(step);
function step(now){
  requestAnimationFrame(step);

  // Time scaling for hit-pause
  const frozen = now < world.timeFreezeUntil;
  const dtMs = frozen ? 0.0001 : (now - last); // effectively paused
  last = now;
  const dt = dtMs / 16.66;

  pollGamepad();

  // MOVE (left stick) + keyboard fallback
  const kmx = (keys['KeyA']||keys['ArrowLeft']?-1:0) + (keys['KeyD']||keys['ArrowRight']?1:0);
  const kmy = (keys['KeyW']||keys['ArrowUp']?-1:0) + (keys['KeyS']||keys['ArrowDown']?1:0);
  const moveX = kmx || input.lx, moveY = kmy || input.ly;

  player.vx += moveX * CFG.accel * (frozen?0:1);
  player.vy += moveY * CFG.accel * (frozen?0:1);
  player.vx *= CFG.friction; player.vy *= CFG.friction;
  const sp=Math.hypot(player.vx,player.vy); if(sp>CFG.maxSpeed){ const k=CFG.maxSpeed/sp; player.vx*=k; player.vy*=k; }
  player.x += player.vx * (frozen?0:1); player.y += player.vy * (frozen?0:1);

  // AIM (right stick) — independent; keeps last when idle
  if(Math.abs(input.rx)+Math.abs(input.ry) > 0.001){
    player.aim.x = input.rx; player.aim.y = input.ry;
    player.rot = Math.atan2(player.aim.y, player.aim.x);
  }

  // FIRE edge detection (no auto)
  const justPressed = input.fire && !input.prevFire;
  if(justPressed && (now - player.lastShot) > CFG.bulletCooldownMs){
    player.lastShot = now;
    shoot();
  }
  input.prevFire = input.fire;

  // Update bullets + hits
  for(let i=world.bullets.length-1;i>=0;i--){
    const b=world.bullets[i];
    b.x += b.vx * (frozen?0:1);
    b.y += b.vy * (frozen?0:1);
    if((now - b.birth) > 1500){ world.bullets.splice(i,1); continue; }

    if(dummy.alive && pointInRect(b.x,b.y,dummy)){
      world.bullets.splice(i,1);
      dummy.hp--;
      // FX
      world.fx.push({ type:'impact', x:b.x, y:b.y, birth:now });
      addDamageText(b.x, b.y, 34);  // temp fixed damage
      // Hit-pause + shake
      world.timeFreezeUntil = now + CFG.hitPauseMs;
      world.shakeMag = CFG.shakeOnHit; world.shakeT = now + 120;
      if(dummy.hp<=0){ dummy.alive=false; setTimeout(()=>{ dummy=spawnDummy(); }, 600); }
    }
  }

  // Expire FX & dmg text
  for(let i=world.fx.length-1;i>=0;i--){
    const f=world.fx[i]; if(now - f.birth > 240) world.fx.splice(i,1);
  }
  for(let i=world.dmg.length-1;i>=0;i--){
    const d=world.dmg[i]; const t = (now - d.birth);
    d.y = d.baseY - (CFG.dmgFloatUp * (t/CFG.dmgLife));
    d.alpha = Math.max(0, 1 - t/CFG.dmgLife);
    if(t > CFG.dmgLife) world.dmg.splice(i,1);
  }

  draw(now);
}

/* ----- Actions ----- */
function shoot(){
  // muzzle pos
  const bx = player.x + Math.cos(player.rot)*(player.r+10);
  const by = player.y + Math.sin(player.rot)*(player.r+10);
  // bullet
  world.bullets.push({
    x:bx, y:by,
    vx:Math.cos(player.rot)*CFG.bulletSpeed,
    vy:Math.sin(player.rot)*CFG.bulletSpeed,
    birth: performance.now()
  });
  // recoil
  player.vx -= Math.cos(player.rot)*CFG.recoilImpulse;
  player.vy -= Math.sin(player.rot)*CFG.recoilImpulse;
  // muzzle flash + shot shake
  world.fx.push({ type:'muzzle', x:bx, y:by, rot:player.rot, birth:performance.now() });
  world.shakeMag = Math.max(world.shakeMag, CFG.shakeOnShot); world.shakeT = performance.now() + 90;
}

function addDamageText(x,y,amount){
  world.dmg.push({ x, y, baseY:y, txt:String(amount), birth:performance.now(), alpha:1 });
}

/* ----- Render ----- */
function draw(now){
  // camera shake (micro, decays fast)
  const shaking = now < world.shakeT;
  const sx = shaking ? (Math.random()*2-1)*world.shakeMag : 0;
  const sy = shaking ? (Math.random()*2-1)*world.shakeMag : 0;

  // bg
  ctx.save();
  ctx.translate(sx, sy);
  ctx.fillStyle='#0b0d10';
  ctx.fillRect(0,0,canvas.width/devicePixelRatio,canvas.height/devicePixelRatio);

  // grid
  const g=CFG.grid; ctx.globalAlpha=0.18; ctx.strokeStyle='#3b414a'; ctx.lineWidth=1; ctx.beginPath();
  for(let x=0;x<innerWidth;x+=g){ ctx.moveTo(x+.5,0); ctx.lineTo(x+.5,innerHeight); }
  for(let y=0;y<innerHeight;y+=g){ ctx.moveTo(0,y+.5); ctx.lineTo(innerWidth,y+.5); }
  ctx.stroke(); ctx.globalAlpha=1;

  // bullets
  ctx.fillStyle='#9ad1ff';
  for(const b of world.bullets){ ctx.beginPath(); ctx.arc(b.x,b.y,3,0,Math.PI*2); ctx.fill(); }

  // FX
  for(const f of world.fx){
    const age = (now - f.birth);
    if(f.type==='impact'){
      const a = Math.max(0, 1 - age/240);
      ctx.globalAlpha = a;
      ctx.strokeStyle = '#9ad1ff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(f.x,f.y, 6+age*0.04, 0, Math.PI*2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if(f.type==='muzzle'){
      const life = Math.max(0, 1 - age/120);
      if(life<=0) continue;
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.rot);
      ctx.globalAlpha = 0.35 * life;
      // pressure cone (thin, fast)
      ctx.fillStyle = '#f7f3d4';
      ctx.beginPath();
      ctx.moveTo(0,0);
      ctx.lineTo(18+age*0.05, 4);
      ctx.lineTo(18+age*0.05,-4);
      ctx.closePath();
      ctx.fill();
      // flash core
      ctx.globalAlpha = 0.6 * life;
      ctx.fillStyle = '#fff6c3';
      ctx.fillRect(0,-1.5, 10, 3);
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  // damage numbers
  for(const d of world.dmg){
    ctx.globalAlpha = d.alpha*0.9;
    ctx.fillStyle = '#e8ecf2';
    ctx.font = '600 12px -apple-system, system-ui, sans-serif';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(d.txt, d.x, d.y);
    ctx.globalAlpha = 1;
  }

  // dummy
  if(dummy.alive){
    ctx.fillStyle='#303844'; ctx.strokeStyle='#c8ccd2'; ctx.lineWidth=2;
    ctx.fillRect(dummy.x-dummy.w/2, dummy.y-dummy.h/2, dummy.w, dummy.h);
    ctx.strokeRect(dummy.x-dummy.w/2, dummy.y-dummy.h/2, dummy.w, dummy.h);
    // hp pips
    for(let i=0;i<dummy.hp;i++){
      ctx.fillStyle='#ff7575';
      ctx.fillRect(dummy.x-12+i*8, dummy.y-dummy.h/2-8, 6, 4);
    }
  }

  // player
  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.rotate(player.rot);
  ctx.fillStyle='#e7ecf2'; ctx.beginPath(); ctx.arc(0,0,player.r,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle='#87a6ff'; ctx.lineWidth=3; ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(player.r+10,0); ctx.stroke();
  ctx.restore();

  ctx.restore(); // end shake translate
}