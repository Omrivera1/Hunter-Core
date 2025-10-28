/* HUNTER-CORE r7 -- Gunfeel blend + smooth aim
   - LEFT=move, RIGHT=aim (invert OFF), no auto-fire unless weapon mode=auto/burst
   - Smooth barrel rotation (shortest-angle lerp) + light aim filtering
   - Impact-only screenshake
   - Single bullet with subtle hybrid trail (tracer + gas-tear + snap), no multi-smear
   - Weapon system scaffold: semi/auto/burst (pistol stays semi)
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
  grid: 48,

  // bullets / gunfeel
  bulletSpeed: 19,
  impactShake: 1.6,   // shake ONLY on impact
  hitPauseMs: 70,     // micro freeze on hit
  recoilImpulse: 2.1, // physical push on fire

  // smoothing
  rotFollow: 12.0,    // how fast barrel rotates toward aim (bigger = snappier, but still smooth)
  aimFilter: 0.35,    // low-pass on stick aim when active (0..1)

  // trail
  trailPoints: 6,     // how many samples to render behind bullet
  trailFade: 0.22,    // alpha falloff per segment
};
/* ================== */

const world = { bullets:[], fx:[], dmg:[], shakeT:0, shakeMag:0, timeFreezeUntil:0 };

const player = {
  x: innerWidth/2, y: innerHeight/2,
  vx:0, vy:0, r:14,
  rot:0,           // current rendered rotation
  targetRot:0,     // where we want to face
  lastShot:0,
  aim:{x:1, y:0},  // smoothed aim vector
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

/* ----- Targets (dummy) ----- */
let dummy = spawnDummy();
function spawnDummy(){ return { x:innerWidth*0.65, y:innerHeight*0.5, w:26, h:32, alive:true, hp:6 }; }
function pointInRect(px,py,r){ return px>=r.x-r.w/2 && px<=r.x+r.w/2 && py>=r.y-r.h/2 && py<=r.y+r.h/2; }

/* ----- Weapons scaffold ----- */
const weapons = {
  pistol: { mode:'semi', rpm:520, burstCount:0, burstGapMs:0, recoil:CFG.recoilImpulse },
  smg:    { mode:'auto', rpm:800, burstCount:0, burstGapMs:0, recoil:1.3 },
  ar:     { mode:'auto', rpm:690, burstCount:0, burstGapMs:0, recoil:1.8 },
  burst:  { mode:'burst', rpm:900, burstCount:3, burstGapMs:55, recoil:1.5 }
};
let weapon = weapons.pistol; // current loadout (we'll expose a switcher later)

function fireIntervalMs(w){ return Math.max(30, Math.floor(60000 / w.rpm)); }

let burstQueue = 0, nextBurstAt = 0;

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
  const kmx=(keys['KeyA']||keys['ArrowLeft']?-1:0)+(keys['KeyD']||keys['ArrowRight']?1:0);
  const kmy=(keys['KeyW']||keys['ArrowUp']?-1:0)+(keys['KeyS']||keys['ArrowDown']?1:0);
  const moveX = kmx || input.lx, moveY = kmy || input.ly;

  player.vx += moveX * CFG.accel * (frozen?0:1);
  player.vy += moveY * CFG.accel * (frozen?0:1);
  player.vx *= CFG.friction; player.vy *= CFG.friction;
  const sp=Math.hypot(player.vx,player.vy); if(sp>CFG.maxSpeed){ const k=CFG.maxSpeed/sp; player.vx*=k; player.vy*=k; }
  player.x += player.vx * (frozen?0:1);
  player.y += player.vy * (frozen?0:1);

  // AIM smoothing (right stick only; keep last if idle)
  const aimMag = Math.hypot(input.rx, input.ry);
  if(aimMag > 0.001){
    // low-pass filter the stick to remove chatter
    const nx = input.rx/aimMag, ny = input.ry/aimMag;
    player.aim.x = lerp(player.aim.x, nx, CFG.aimFilter);
    player.aim.y = lerp(player.aim.y, ny, CFG.aimFilter);
  }
  // compute target rot from filtered aim; if no aim input, keep prior
  if(aimMag > 0.05){
    player.targetRot = Math.atan2(player.aim.y, player.aim.x);
  }
  // smooth rotation toward target (shortest angle)
  player.rot = angleLerp(player.rot, player.targetRot, clamp01(dt * CFG.rotFollow));

  // FIRE control
  const interval = fireIntervalMs(weapon);
  const justPressed = input.fire && !input.prevFire;
  if(!frozen){
    if(weapon.mode === 'semi'){
      if(justPressed && now - player.lastShot > interval) doShoot(now, weapon.recoil);
    } else if(weapon.mode === 'auto'){
      if(input.fire && now - player.lastShot > interval) doShoot(now, weapon.recoil);
    } else if(weapon.mode === 'burst'){
      if(justPressed && burstQueue===0){ burstQueue = weapon.burstCount; nextBurstAt = now; }
      if(burstQueue>0 && now >= nextBurstAt){
        doShoot(now, weapon.recoil);
        burstQueue--;
        nextBurstAt = now + weapon.burstGapMs;
      }
    }
  }
  input.prevFire = input.fire;

  // bullets
  for(let i=world.bullets.length-1;i>=0;i--){
    const b=world.bullets[i];
    if(!frozen){
      // trail sample
      b.trail.unshift({x:b.x, y:b.y});
      if(b.trail.length > CFG.trailPoints) b.trail.pop();
      // advance
      b.x += b.vx; b.y += b.vy;
    }
    // lifetime / bounds
    if((now - b.birth) > 1500 || b.x<-80 || b.y<-80 || b.x>innerWidth+80 || b.y>innerHeight+80){
      world.bullets.splice(i,1); continue;
    }
    // impact
    if(dummy.alive && pointInRect(b.x,b.y,dummy)){
      world.bullets.splice(i,1);
      dummy.hp--;
      impactFX(b.x,b.y, now);
      if(dummy.hp<=0){ dummy.alive=false; setTimeout(()=>{ dummy=spawnDummy(); }, 600); }
    }
  }

  // FX & damage text
  for(let i=world.fx.length-1;i>=0;i--){
    const f=world.fx[i]; if(now - f.birth > f.lifeMs) world.fx.splice(i,1);
  }
  for(let i=world.dmg.length-1;i>=0;i--){
    const d=world.dmg[i];
    const t = now - d.birth;
    d.y = d.baseY - (26 * (t/500));
    d.alpha = Math.max(0, 1 - t/500);
    if(t>500) world.dmg.splice(i,1);
  }

  draw(now);
}

/* ----- Shoot / Impact ----- */
function doShoot(now, recoil){
  player.lastShot = now;

  const bx = player.x + Math.cos(player.rot)*(player.r+10);
  const by = player.y + Math.sin(player.rot)*(player.r+10);

  world.bullets.push({
    x:bx, y:by,
    vx:Math.cos(player.rot)*CFG.bulletSpeed,
    vy:Math.sin(player.rot)*CFG.bulletSpeed,
    birth: now,
    trail: []   // recent positions for hybrid trail
  });

  // recoil (physical, tiny)
  player.vx -= Math.cos(player.rot)*recoil;
  player.vy -= Math.sin(player.rot)*recoil;

  // muzzle visual (very fast, gas-pressure style)
  world.fx.push({ type:'muzzle', x:bx, y:by, rot:player.rot, birth:now, lifeMs:120 });
}

function impactFX(x,y, now){
  // ONLY on impact: micro hit-pause + stronger shake
  world.timeFreezeUntil = now + CFG.hitPauseMs;
  world.shakeMag = 1.0 * CFG.impactShake; world.shakeT = now + 130;

  // ring burst
  world.fx.push({ type:'impact', x, y, birth:now, lifeMs:240 });

  // tiny damage number (surgical)
  world.dmg.push({ x, y, baseY:y, txt:'34', birth:now, alpha:1 });
}

/* ----- Helpers ----- */
function lerp(a,b,t){ return a + (b-a)*t; }
function clamp01(v){ return v<0?0:v>1?1:v; }
function angleLerp(a, b, t){
  let d = (b - a) % (Math.PI*2);
  if (d > Math.PI) d -= Math.PI*2;
  if (d < -Math.PI) d += Math.PI*2;
  return a + d * t;
}

/* ----- Render ----- */
function draw(now){
  // camera shake (impact only)
  const shaking = now < world.shakeT;
  const sx = shaking ? (Math.random()*2-1)*world.shakeMag : 0;
  const sy = shaking ? (Math.random()*2-1)*world.shakeMag : 0;

  ctx.save();
  ctx.translate(sx, sy);

  // bg
  ctx.fillStyle='#0b0d10';
  ctx.fillRect(0,0,canvas.width/devicePixelRatio,canvas.height/devicePixelRatio);

  // grid
  const g=CFG.grid; ctx.globalAlpha=0.18; ctx.strokeStyle='#3b414a'; ctx.lineWidth=1; ctx.beginPath();
  for(let x=0;x<innerWidth;x+=g){ ctx.moveTo(x+.5,0); ctx.lineTo(x+.5,innerHeight); }
  for(let y=0;y<innerHeight;y+=g){ ctx.moveTo(0,y+.5); ctx.lineTo(innerWidth,y+.5); }
  ctx.stroke(); ctx.globalAlpha=1;

  // bullets + hybrid trail
  for(const b of world.bullets){
    // trail: draw from newest to oldest, fading
    for(let i=0;i<b.trail.length;i++){
      const p = b.trail[i], a = Math.max(0, 1 - i*CFG.trailFade);
      ctx.globalAlpha = 0.18 * a;                // faint pressure shimmer
      ctx.strokeStyle = '#b9c7d6';
      ctx.lineWidth = 2 - i*0.25;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(i? b.trail[i-1].x : b.x, i? b.trail[i-1].y : b.y); ctx.stroke();

      ctx.globalAlpha = 0.10 * a;                // subtle tracer glow
      ctx.strokeStyle = '#dfe9ff';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(i? b.trail[i-1].x : b.x, i? b.trail[i-1].y : b.y); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // core pellet
    ctx.fillStyle='#e9f1ff';
    ctx.beginPath(); ctx.arc(b.x,b.y,2.3,0,Math.PI*2); ctx.fill();
  }

  // FX
  for(const f of world.fx){
    const age = now - f.birth;
    if(f.type==='impact'){
      const a = Math.max(0, 1 - age/240);
      ctx.globalAlpha = a; ctx.strokeStyle = '#9ad1ff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(f.x,f.y, 6+age*0.04, 0, Math.PI*2); ctx.stroke(); ctx.globalAlpha=1;
    }
    if(f.type==='muzzle'){
      const life = Math.max(0, 1 - age/120); if(life<=0) continue;
      ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.rot);
      // pressure cone (fast, tight) -- Wick gas-tear vibe
      ctx.globalAlpha = 0.33 * life; ctx.fillStyle = '#f7f3d4';
      ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(16+age*0.04, 3.5); ctx.lineTo(16+age*0.04,-3.5); ctx.closePath(); ctx.fill();
      // snap core
      ctx.globalAlpha = 0.55 * life; ctx.fillStyle = '#fff6c3';
      ctx.fillRect(0,-1.2, 8.5, 2.4);
      ctx.restore(); ctx.globalAlpha=1;
    }
  }

  // damage numbers
  for(const d of world.dmg){
    ctx.globalAlpha = d.alpha*0.9; ctx.fillStyle = '#e8ecf2';
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
    for(let i=0;i<dummy.hp;i++){ ctx.fillStyle='#ff7575'; ctx.fillRect(dummy.x-12+i*8,dummy.y-dummy.h/2-8,6,4); }
  }

  // player
  ctx.save(); ctx.translate(player.x, player.y); ctx.rotate(player.rot);
  ctx.fillStyle='#e7ecf2'; ctx.beginPath(); ctx.arc(0,0,player.r,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle='#87a6ff'; ctx.lineWidth=3; ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(player.r+10,0); ctx.stroke();
  ctx.restore();

  ctx.restore(); // end shake translate
}