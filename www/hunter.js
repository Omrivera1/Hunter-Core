/* HUNTER-CORE r9 -- M2 Collision Pass
   Fixes: clipping, jitter on shoot & edges, camera-edge ghosting
   - Substep integration to prevent tunneling
   - Axis-by-axis circle-vs-tile resolution
   - Hard world bounds (no ghost wall at camera edge)
   - Camera clamp corrected
   Keeps: LEFT=move, RIGHT=aim, smooth rot, impact-only shake, hybrid trail
*/

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', { alpha:false });
function resize(){ canvas.width=innerWidth*devicePixelRatio; canvas.height=innerHeight*devicePixelRatio; }
addEventListener('resize', resize, {passive:true}); resize();
ctx.scale(devicePixelRatio, devicePixelRatio);

/* ===== CONFIG ===== */
const CFG = {
  // movement
  friction: 0.88, accel: 0.85, maxSpeed: 7.2, grid: 48,
  // bullets / feel
  bulletSpeed: 19, impactShake: 1.6, hitPauseMs: 70,
  // aim smoothing
  rotFollow: 12.0, aimFilter: 0.35,
  // trails
  trailPoints: 6, trailFade: 0.22,
  // recoil (grounded)
  recoilVelocityFactor: 0.28,   // ← slightly lower to reduce slide
  recoilAimKick: 0.07,
  aimKickDecay: 0.86,
  // tiles
  tileSize: 48,
  // physics integration
  substepsMax: 4,              // split fast motion into up to 4 micro-steps
  epsilon: 0.001               // small nudge to avoid re-penetration
};

/* ===== MAP: mid-block warzone slice ===== */
const MAP = { cols: 20, rows: 12, tiles: [], width: 0, height: 0 };
(function buildMap(){
  const c=MAP.cols, r=MAP.rows, T=[];
  for(let y=0;y<r;y++){ T[y]=[]; for(let x=0;x<c;x++) T[y][x]=0; }
  // perimeter walls to create hard world bounds
  for(let x=0;x<c;x++){ T[0][x]=1; T[r-1][x]=1; }
  for(let y=0;y<r;y++){ T[y][0]=1; T[y][c-1]=1; }
  // left/right "buildings"
  for(let y=2;y<r-2;y++){ T[y][2]=1; T[y][3]=1; T[y][c-3]=1; T[y][c-4]=1; }
  // cover chunks
  const covers = [[7,5],[9,7],[12,4],[14,8],[10,6]];
  for(const [cx,cy] of covers) T[cy][cx]=1;
  MAP.tiles=T; MAP.width=c*CFG.tileSize; MAP.height=r*CFG.tileSize;
})();

/* ===== WORLD ===== */
const world = { bullets:[], fx:[], dmg:[], shakeT:0, shakeMag:0, timeFreezeUntil:0 };

/* ===== PLAYER ===== */
const player = {
  x: MAP.width*0.5 - CFG.tileSize*2, y: MAP.height*0.5, vx:0, vy:0, r:14,
  rot:0, targetRot:0, aim:{x:1,y:0}, lastShot:0, aimKick:0
};

/* ===== CAMERA (no edge jitter) ===== */
const camera = { x:0, y:0, w: Math.min(innerWidth, MAP.width), h: Math.min(innerHeight, MAP.height) };
function clamp(v,lo,hi){ return v<lo?lo:(v>hi?hi:v); }

/* ===== INPUT ===== */
const input = { lx:0, ly:0, rx:0, ry:0, fire:false, prevFire:false };
const keys = {};
addEventListener('keydown', e=>{ keys[e.code]=true; if(e.code==='Space') input.fire=true; });
addEventListener('keyup',   e=>{ keys[e.code]=false; if(e.code==='Space') input.fire=false; });

/* ----- Touch sticks (left move / right aim) ----- */
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

/* ----- Gamepad (Backbone) ----- */
function dead(v){ const d=0.14; return Math.abs(v)<d?0:v; }
function pollGamepad(){
  const gp=navigator.getGamepads?.()[0]; if(!gp) return;
  input.lx=dead(gp.axes[0]); input.ly=dead(gp.axes[1]);
  input.rx=dead(gp.axes[2]); input.ry=dead(gp.axes[3]);
  input.fire = !!gp.buttons?.[7]?.pressed || !!keys['Space'];
}

/* ----- Dummy target ----- */
let dummy = spawnDummy();
function spawnDummy(){ return { x: MAP.width*0.65, y: MAP.height*0.5, w:26, h:32, alive:true, hp:6 }; }
function pointInRect(px,py,r){ return px>=r.x-r.w/2 && px<=r.x+r.w/2 && py>=r.y-r.h/2 && py<=r.y+r.h/2; }

/* ----- Weapons scaffold ----- */
const weapons = {
  pistol: { mode:'semi', rpm:520, burstCount:0, burstGapMs:0, recoil:1.6 },
  smg:    { mode:'auto', rpm:800, burstCount:0, burstGapMs:0, recoil:1.1 },
  ar:     { mode:'auto', rpm:690, burstCount:0, burstGapMs:0, recoil:1.5 },
  burst:  { mode:'burst', rpm:900, burstCount:3, burstGapMs:55, recoil:1.3 }
};
let weapon = weapons.pistol;
function fireIntervalMs(w){ return Math.max(30, Math.floor(60000 / w.rpm)); }
let burstQueue=0, nextBurstAt=0;

/* ===== Tile helpers ===== */
const TS = CFG.tileSize;
function tileSolidAt(tx,ty){
  if(tx<0||ty<0||tx>=MAP.cols||ty>=MAP.rows) return true;
  return MAP.tiles[ty][tx]===1;
}
function collideCircleVsTilesAxis(px,py,r, dx, dy){
  // Move on X, resolve; then move on Y, resolve
  let x = px + dx, y = py;
  const left = Math.floor((x - r)/TS), right = Math.floor((x + r)/TS);
  const top  = Math.floor((y - r)/TS), bottom= Math.floor((y + r)/TS);
  // resolve X
  if(dx>0){
    const tx = right; for(let ty=top; ty<=bottom; ty++){
      if(tileSolidAt(tx,ty)){
        const tileLeft = tx*TS;
        const pen = (x + r) - tileLeft;
        if(pen > 0){ x -= pen + CFG.epsilon; }
      }
    }
  } else if(dx<0){
    const tx = left; for(let ty=top; ty<=bottom; ty++){
      if(tileSolidAt(tx,ty)){
        const tileRight = tx*TS + TS;
        const pen = tileRight - (x - r);
        if(pen > 0){ x += pen + CFG.epsilon; }
      }
    }
  }
  // update bounds for Y resolution
  const left2 = Math.floor((x - r)/TS), right2 = Math.floor((x + r)/TS);
  // resolve Y
  y = y + dy;
  if(dy>0){
    const ty = Math.floor((y + r)/TS);
    for(let tx=left2; tx<=right2; tx++){
      if(tileSolidAt(tx,ty)){
        const tileTop = ty*TS;
        const pen = (y + r) - tileTop;
        if(pen > 0){ y -= pen + CFG.epsilon; }
      }
    }
  } else if(dy<0){
    const ty = Math.floor((y - r)/TS);
    for(let tx=left2; tx<=right2; tx++){
      if(tileSolidAt(tx,ty)){
        const tileBottom = ty*TS + TS;
        const pen = tileBottom - (y - r);
        if(pen > 0){ y += pen + CFG.epsilon; }
      }
    }
  }
  // clamp to hard world bounds (avoid camera-edge ghosting)
  x = clamp(x, r+CFG.epsilon, MAP.width - r - CFG.epsilon);
  y = clamp(y, r+CFG.epsilon, MAP.height - r - CFG.epsilon);
  return {x,y};
}

/* ===== LOOP ===== */
let last = performance.now();
requestAnimationFrame(step);
function step(now){
  requestAnimationFrame(step);
  const frozen = now < world.timeFreezeUntil;
  const dtMs = frozen ? 0.0001 : (now - last);
  last = now;
  const dt = dtMs / 16.66;

  pollGamepad();

  // movement intent
  const kmx=(keys['KeyA']||keys['ArrowLeft']?-1:0)+(keys['KeyD']||keys['ArrowRight']?1:0);
  const kmy=(keys['KeyW']||keys['ArrowUp']?-1:0)+(keys['KeyS']||keys['ArrowDown']?1:0);
  const moveX = kmx || input.lx, moveY = kmy || input.ly;

  // accel + friction
  player.vx += (frozen?0:moveX * CFG.accel);
  player.vy += (frozen?0:moveY * CFG.accel);
  player.vx *= CFG.friction; player.vy *= CFG.friction;
  const sp=Math.hypot(player.vx,player.vy);
  if(sp>CFG.maxSpeed){ const k=CFG.maxSpeed/sp; player.vx*=k; player.vy*=k; }

  // AIM smoothing
  const aimMag = Math.hypot(input.rx, input.ry);
  if(aimMag > 0.001){
    const nx=input.rx/aimMag, ny=input.ry/aimMag;
    player.aim.x = lerp(player.aim.x, nx, CFG.aimFilter);
    player.aim.y = lerp(player.aim.y, ny, CFG.aimFilter);
  }
  if(aimMag > 0.05) player.targetRot = Math.atan2(player.aim.y, player.aim.x);

  // decay aim kick
  if(player.aimKick){ player.aimKick *= CFG.aimKickDecay; if(Math.abs(player.aimKick)<0.0001) player.aimKick=0; }
  const targetWithKick = player.targetRot + player.aimKick;
  player.rot = angleLerp(player.rot, targetWithKick, clamp01(dt * CFG.rotFollow));

  // FIRE modes
  const interval = fireIntervalMs(weapon);
  const justPressed = input.fire && !input.prevFire;
  if(!frozen){
    if(weapon.mode==='semi'){ if(justPressed && now - player.lastShot > interval) doShoot(now, weapon.recoil); }
    else if(weapon.mode==='auto'){ if(input.fire && now - player.lastShot > interval) doShoot(now, weapon.recoil); }
    else if(weapon.mode==='burst'){
      if(justPressed && burstQueue===0){ burstQueue=weapon.burstCount; nextBurstAt=now; }
      if(burstQueue>0 && now>=nextBurstAt){ doShoot(now, weapon.recoil); burstQueue--; nextBurstAt=now+weapon.burstGapMs; }
    }
  }
  input.prevFire = input.fire;

  // INTEGRATE with substeps to avoid tunneling
  if(!frozen){
    const steps = Math.min(CFG.substepsMax, Math.max(1, Math.ceil(Math.max(Math.abs(player.vx), Math.abs(player.vy)) / 5)));
    const stepDX = player.vx / steps;
    const stepDY = player.vy / steps;
    let x = player.x, y = player.y;
    for(let i=0;i<steps;i++){
      const pos = collideCircleVsTilesAxis(x,y, player.r, stepDX, 0);
      x = pos.x; y = pos.y;
      const pos2 = collideCircleVsTilesAxis(x,y, player.r, 0, stepDY);
      x = pos2.x; y = pos2.y;
    }
    player.x = x; player.y = y;
  }

  // bullets
  for(let i=world.bullets.length-1;i>=0;i--){
    const b=world.bullets[i];
    if(!frozen){
      b.trail.unshift({x:b.x,y:b.y}); if(b.trail.length>CFG.trailPoints) b.trail.pop();
      b.x += b.vx; b.y += b.vy;
    }
    if((now - b.birth) > 1500 || b.x<-80 || b.y<-80 || b.x>MAP.width+80 || b.y>MAP.height+80){ world.bullets.splice(i,1); continue; }
    if(dummy.alive && pointInRect(b.x,b.y,dummy)){
      world.bullets.splice(i,1); dummy.hp--; impactFX(b.x,b.y, now);
      if(dummy.hp<=0){ dummy.alive=false; setTimeout(()=>{ dummy=spawnDummy(); },600); }
    }
  }

  // FX & dmg decay
  for(let i=world.fx.length-1;i>=0;i--){ if(now - world.fx[i].birth > world.fx[i].lifeMs) world.fx.splice(i,1); }
  for(let i=world.dmg.length-1;i>=0;i--){ const d=world.dmg[i]; const t=now-d.birth; d.y=d.baseY-(26*(t/500)); d.alpha=Math.max(0,1-t/500); if(t>500) world.dmg.splice(i,1); }

  // CAMERA clamp (no jitter)
  camera.w = Math.min(innerWidth, MAP.width); camera.h = Math.min(innerHeight, MAP.height);
  camera.x = clamp(player.x - camera.w/2, 0, MAP.width - camera.w);
  camera.y = clamp(player.y - camera.h/2, 0, MAP.height - camera.h);

  draw(now);
}

/* ===== Shoot / Impact ===== */
function doShoot(now, recoil){
  player.lastShot = now;
  const bx = player.x + Math.cos(player.rot)*(player.r+10);
  const by = player.y + Math.sin(player.rot)*(player.r+10);

  world.bullets.push({ x:bx, y:by, vx:Math.cos(player.rot)*CFG.bulletSpeed, vy:Math.sin(player.rot)*CFG.bulletSpeed, birth:now, trail:[] });

  // grounded recoil: smaller physical shove, then aim kick (decays)
  const shove = recoil * CFG.recoilVelocityFactor;
  player.vx -= Math.cos(player.rot) * shove;
  player.vy -= Math.sin(player.rot) * shove;
  player.aimKick += (Math.random()*2-1)*(recoil*0.015) + recoil*CFG.recoilAimKick;

  world.fx.push({ type:'muzzle', x:bx, y:by, rot:player.rot, birth:now, lifeMs:120 });
}
function impactFX(x,y, now){
  world.timeFreezeUntil = now + CFG.hitPauseMs;
  world.shakeMag = 1.0 * CFG.impactShake; world.shakeT = now + 130;
  world.fx.push({ type:'impact', x, y, birth:now, lifeMs:240 });
  world.dmg.push({ x, y, baseY:y, txt:'34', birth:now, alpha:1 });
}

/* ===== Helpers ===== */
function lerp(a,b,t){ return a + (b-a)*t; }
function clamp01(v){ return v<0?0:v>1?1:v; }
function angleLerp(a,b,t){ let d=(b-a)%(Math.PI*2); if(d>Math.PI) d-=Math.PI*2; if(d<-Math.PI) d+=Math.PI*2; return a + d*t; }

/* ===== Render ===== */
function draw(now){
  const shaking = now < world.shakeT;
  const sx = shaking ? (Math.random()*2-1)*world.shakeMag : 0;
  const sy = shaking ? (Math.random()*2-1)*world.shakeMag : 0;

  ctx.save();
  ctx.translate(-camera.x + sx, -camera.y + sy);

  // tiles
  ctx.fillStyle='#0d0f12';
  ctx.fillRect(camera.x, camera.y, camera.w, camera.h);
  for(let ty=0; ty<MAP.rows; ty++){
    for(let tx=0; tx<MAP.cols; tx++){
      const t = MAP.tiles[ty][tx]; const px=tx*TS, py=ty*TS;
      if(t===1){ ctx.fillStyle='#24282c'; ctx.fillRect(px,py,TS,TS); ctx.strokeStyle='#1c1f22'; ctx.lineWidth=2; ctx.strokeRect(px,py,TS,TS); }
      else{ ctx.fillStyle='#16181b'; ctx.fillRect(px,py,TS,TS); if((tx+ty)%2===0){ ctx.globalAlpha=0.02; ctx.fillStyle='#fff'; ctx.fillRect(px,py,TS,TS); ctx.globalAlpha=1; } }
    }
  }

  // bullets + trail
  for(const b of world.bullets){
    for(let i=0;i<b.trail.length;i++){
      const p=b.trail[i], a=Math.max(0,1 - i*CFG.trailFade);
      ctx.globalAlpha = 0.18*a; ctx.strokeStyle='#b9c7d6'; ctx.lineWidth=2 - i*0.25;
      ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(i? b.trail[i-1].x : b.x, i? b.trail[i-1].y : b.y); ctx.stroke();
      ctx.globalAlpha = 0.10*a; ctx.strokeStyle='#dfe9ff'; ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(i? b.trail[i-1].x : b.x, i? b.trail[i-1].y : b.y); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle='#e9f1ff'; ctx.beginPath(); ctx.arc(b.x,b.y,2.3,0,Math.PI*2); ctx.fill();
  }

  // fx
  for(const f of world.fx){
    const age = now - f.birth;
    if(f.type==='impact'){
      const a = Math.max(0, 1 - age/240);
      ctx.globalAlpha=a; ctx.strokeStyle='#9ad1ff'; ctx.lineWidth=2;
      ctx.beginPath(); ctx.arc(f.x,f.y, 6+age*0.04, 0, Math.PI*2); ctx.stroke(); ctx.globalAlpha=1;
    }
    if(f.type==='muzzle'){
      const life = Math.max(0, 1 - age/120); if(life<=0) continue;
      ctx.save(); ctx.translate(f.x,f.y); ctx.rotate(f.rot);
      ctx.globalAlpha = 0.33*life; ctx.fillStyle='#f7f3d4';
      ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(16+age*0.04,3.5); ctx.lineTo(16+age*0.04,-3.5); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 0.55*life; ctx.fillStyle='#fff6c3'; ctx.fillRect(0,-1.2,8.5,2.4);
      ctx.restore(); ctx.globalAlpha=1;
    }
  }

  // dummy
  if(dummy.alive){
    ctx.fillStyle='#303844'; ctx.strokeStyle='#c8ccd2'; ctx.lineWidth=2;
    ctx.fillRect(dummy.x-dummy.w/2, dummy.y-dummy.h/2, dummy.w, dummy.h);
    ctx.strokeRect(dummy.x-dummy.w/2, dummy.y-dummy.h/2, dummy.w, dummy.h);
    for(let i=0;i<dummy.hp;i++){ ctx.fillStyle='#ff7575'; ctx.fillRect(dummy.x-12+i*8,dummy.y-dummy.h/2-8,6,4); }
  }

  // player
  ctx.save(); ctx.translate(player.x,player.y); ctx.rotate(player.rot);
  ctx.fillStyle='#e7ecf2'; ctx.beginPath(); ctx.arc(0,0,player.r,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle='#87a6ff'; ctx.lineWidth=3; ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(player.r+10,0); ctx.stroke();
  ctx.restore();

  // damage numbers
  for(const d of world.dmg){
    ctx.globalAlpha=d.alpha*0.9; ctx.fillStyle='#e8ecf2';
    ctx.font='600 12px -apple-system, system-ui, sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(d.txt,d.x,d.y); ctx.globalAlpha=1;
  }

  ctx.restore();
}