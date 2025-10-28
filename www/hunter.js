/* HUNTER-CORE r8 -- M2 Warzone Mid-Block + grounded recoil
   - LEFT=move, RIGHT=aim (invert OFF), smooth rotation, weapon scaffold
   - Tile map + walls + AABB collision & camera clamp
   - Recoil: small physical shove + aim kick (decays)
   - Impact-only shake, hybrid bullet trail
*/

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', { alpha:false });
function resize(){ canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio; }
addEventListener('resize', resize, {passive:true}); resize();
ctx.scale(devicePixelRatio, devicePixelRatio);

/* ===== CONFIG ===== */
const CFG = {
  // movement + world
  friction: 0.88, accel: 0.85, maxSpeed: 7.2, grid: 48,
  // bullets / gunfeel
  bulletSpeed: 19, impactShake: 1.6, hitPauseMs: 70,
  // smoothing
  rotFollow: 12.0, aimFilter: 0.35,
  // trail
  trailPoints: 6, trailFade: 0.22,
  // recoil tuning (grounded)
  recoilVelocityFactor: 0.35, // fraction of recoil applied as physical shove (was bigger)
  recoilAimKick: 0.08,        // angle radians applied instantly, decays
  aimKickDecay: 0.85,        // multiplier per frame for aim kick
  // tile map
  tileSize: 48
};
/* =================== */

/* ===== WORLD & MAP ===== */
const MAP = {
  cols: 20, rows: 12,
  tiles: [],   // 0 = floor, 1 = wall/solid
  width: 0, height: 0
};

// build a mid-block warzone slice: center street with buildings both sides + some cover
(function buildMap(){
  const c = MAP.cols, r = MAP.rows, T = [];
  for(let y=0;y<r;y++){
    T[y]=[];
    for(let x=0;x<c;x++){
      // default floor
      T[y][x]=0;
    }
  }
  // create left/right building bands (walls)
  for(let y=1;y<r-1;y++){
    T[y][1]=1; T[y][2]=1; // left building edge
    T[y][c-2]=1; T[y][c-3]=1; // right building
  }
  // add some street cover crates (walls) and broken walls
  const covers = [[7,5],[9,7],[12,4],[14,8],[10,6]];
  for(const [cx,cy] of covers) if(cx>2 && cx<c-3) T[cy][cx]=1;
  MAP.tiles=T; MAP.width=c*CFG.tileSize; MAP.height=r*CFG.tileSize;
})();

/* ===== WORLD STATE ===== */
const world = { bullets:[], fx:[], dmg:[], shakeT:0, shakeMag:0, timeFreezeUntil:0 };

/* ===== PLAYER ===== */
const player = {
  x: MAP.width/2 - CFG.tileSize*2, y: MAP.height/2, vx:0, vy:0, r:14,
  rot:0, targetRot:0, aim:{x:1,y:0}, lastShot:0,
  aimKick:0   // temporary aim angle offset from recoil
};

/* ===== CAMERA ===== */
const camera = { x:0,y:0, w: Math.min(innerWidth, MAP.width), h: Math.min(innerHeight, MAP.height) };

/* ===== INPUT ===== */
const input = { lx:0, ly:0, rx:0, ry:0, fire:false, prevFire:false };
const keys = {};
addEventListener('keydown', e=>{ keys[e.code]=true; if(e.code==='Space') input.fire=true; });
addEventListener('keyup',   e=>{ keys[e.code]=false; if(e.code==='Space') input.fire=false; });

/* ----- Touch sticks ----- */
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

/* ----- Gamepad poll ----- */
function dead(v){ const d=0.14; return Math.abs(v) < d ? 0 : v; }
function pollGamepad(){
  const gp = navigator.getGamepads?.()[0]; if(!gp) return;
  input.lx = dead(gp.axes[0]); input.ly = dead(gp.axes[1]); // left = move
  input.rx = dead(gp.axes[2]); input.ry = dead(gp.axes[3]); // right = aim
  input.fire = !!gp.buttons?.[7]?.pressed || !!keys['Space']; // R2 or Space
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
let burstQueue = 0, nextBurstAt = 0;

/* ===== PHYSICS: AABB collision helpers ===== */
function tileAtXY(x,y){ const tx = Math.floor(x/CFG.tileSize), ty = Math.floor(y/CFG.tileSize); if(tx<0||ty<0||tx>=MAP.cols||ty>=MAP.rows) return 1; return MAP.tiles[ty][tx]; }
function getCollidingTilesForCircle(px,py,r){
  const left = Math.floor((px - r)/CFG.tileSize), right = Math.floor((px + r)/CFG.tileSize);
  const top = Math.floor((py - r)/CFG.tileSize), bottom = Math.floor((py + r)/CFG.tileSize);
  const hits = [];
  for(let ty=top; ty<=bottom; ty++){
    for(let tx=left; tx<=right; tx++){
      if(ty>=0 && tx>=0 && ty<MAP.rows && tx<MAP.cols){
        if(MAP.tiles[ty][tx] === 1){
          hits.push({ x: tx*CFG.tileSize, y: ty*CFG.tileSize, w: CFG.tileSize, h: CFG.tileSize });
        }
      } else { // out-of-bounds treat as wall
        hits.push({ x: tx*CFG.tileSize, y: ty*CFG.tileSize, w: CFG.tileSize, h: CFG.tileSize });
      }
    }
  }
  return hits;
}
function resolveCircleAABB(px,py,r, vx, vy){
  // naive resolution: try move, if overlap, push back along smallest overlap axis
  const hits = getCollidingTilesForCircle(px,py,r);
  let nx = px, ny = py;
  for(const t of hits){
    // compute AABB vs circle overlap
    const cx = Math.max(t.x, Math.min(px, t.x + t.w));
    const cy = Math.max(t.y, Math.min(py, t.y + t.h));
    const dx = px - cx, dy = py - cy;
    const distSq = dx*dx + dy*dy;
    if(distSq < r*r){
      const dist = Math.sqrt(Math.max(0.0001, distSq));
      // penetration
      const pen = r - dist;
      // push out along vector (or, if inside corner, choose axis)
      let pushX = dx/dist * pen, pushY = dy/dist * pen;
      if(!isFinite(pushX) || Math.abs(dx) < 0.001) { // near vertical
        // pick axis with smaller overlap
        if(Math.abs(px - (t.x)) < Math.abs(px - (t.x + t.w))) pushX = px - t.x; else pushX = px - (t.x + t.w);
        pushX = pushX < 0 ? -Math.abs(pushX) : Math.abs(pushX);
        pushY = 0;
      }
      nx += pushX; ny += pushY;
    }
  }
  return { nx, ny };
}

/* ===== LOOP ===== */
let last = performance.now();
requestAnimationFrame(step);
function step(now){
  requestAnimationFrame(step);

  // time freeze handling
  const frozen = now < world.timeFreezeUntil;
  const dtMs = frozen ? 0.0001 : (now - last);
  last = now;
  const dt = dtMs / 16.66;

  pollGamepad();

  // MOVE
  const kmx=(keys['KeyA']||keys['ArrowLeft']?-1:0)+(keys['KeyD']||keys['ArrowRight']?1:0);
  const kmy=(keys['KeyW']||keys['ArrowUp']?-1:0)+(keys['KeyS']||keys['ArrowDown']?1:0);
  const moveX = kmx || input.lx, moveY = kmy || input.ly;

  player.vx += moveX * CFG.accel * (frozen?0:1);
  player.vy += moveY * CFG.accel * (frozen?0:1);
  player.vx *= CFG.friction; player.vy *= CFG.friction;
  const sp = Math.hypot(player.vx, player.vy);
  if(sp > CFG.maxSpeed){ const k = CFG.maxSpeed/sp; player.vx*=k; player.vy*=k; }

  // tentative integrate
  let newX = player.x + player.vx * (frozen?0:1);
  let newY = player.y + player.vy * (frozen?0:1);

  // resolve collisions (circle vs tiles)
  const resolved = resolveCircleAABB(newX, newY, player.r, player.vx, player.vy);
  player.x = resolved.nx; player.y = resolved.ny;

  // AIM smoothing (right stick)
  const aimMag = Math.hypot(input.rx, input.ry);
  if(aimMag > 0.001){
    const nx = input.rx/aimMag, ny = input.ry/aimMag;
    player.aim.x = lerp(player.aim.x, nx, CFG.aimFilter);
    player.aim.y = lerp(player.aim.y, ny, CFG.aimFilter);
  }
  if(aimMag > 0.05) player.targetRot = Math.atan2(player.aim.y, player.aim.x);
  // apply aim kick (decay)
  if(player.aimKick) { player.aimKick *= CFG.aimKickDecay; if(Math.abs(player.aimKick) < 0.0001) player.aimKick = 0; }
  // smooth rotation toward target + current aimKick
  const targetWithKick = player.targetRot + player.aimKick;
  player.rot = angleLerp(player.rot, targetWithKick, clamp01(dt * CFG.rotFollow));

  // FIRE / weapon modes
  const interval = fireIntervalMs(weapon);
  const justPressed = input.fire && !input.prevFire;
  if(!frozen){
    if(weapon.mode === 'semi'){
      if(justPressed && now - player.lastShot > interval) doShoot(now, weapon.recoil);
    } else if(weapon.mode === 'auto'){
      if(input.fire && now - player.lastShot > interval) doShoot(now, weapon.recoil);
    } else if(weapon.mode === 'burst'){
      if(justPressed && burstQueue===0){ burstQueue = weapon.burstCount; nextBurstAt = now; }
      if(burstQueue>0 && now >= nextBurstAt){ doShoot(now, weapon.recoil); burstQueue--; nextBurstAt = now + weapon.burstGapMs; }
    }
  }
  input.prevFire = input.fire;

  // bullets update + impact
  for(let i=world.bullets.length-1;i>=0;i--){
    const b = world.bullets[i];
    if(!frozen){
      b.trail.unshift({x:b.x,y:b.y});
      if(b.trail.length > CFG.trailPoints) b.trail.pop();
      b.x += b.vx; b.y += b.vy;
    }
    if((now - b.birth) > 1500 || b.x<-80 || b.y<-80 || b.x>MAP.width+80 || b.y>MAP.height+80){ world.bullets.splice(i,1); continue; }
    if(dummy.alive && pointInRect(b.x,b.y,dummy)){
      world.bullets.splice(i,1); dummy.hp--; impactFX(b.x,b.y, now);
      if(dummy.hp<=0){ dummy.alive=false; setTimeout(()=>{ dummy=spawnDummy(); },600); }
    }
  }

  // expire fx & dmg
  for(let i=world.fx.length-1;i>=0;i--){ if(now - world.fx[i].birth > world.fx[i].lifeMs) world.fx.splice(i,1); }
  for(let i=world.dmg.length-1;i>=0;i--){ const d=world.dmg[i]; const t = now - d.birth; d.y = d.baseY - (26 * (t/500)); d.alpha = Math.max(0,1 - t/500); if(t>500) world.dmg.splice(i,1); }

  // camera follow & clamp
  camera.w = Math.min(innerWidth, MAP.width); camera.h = Math.min(innerHeight, MAP.height);
  camera.x = clamp01((player.x - camera.w/2) / (MAP.width - camera.w)) * (MAP.width - camera.w);
  camera.y = clamp01((player.y - camera.h/2) / (MAP.height - camera.h)) * (MAP.height - camera.h);

  draw(now);
}

/* ----- Shoot / Impact (grounded recoil + aim kick) ----- */
function doShoot(now, recoil){
  player.lastShot = now;
  const bx = player.x + Math.cos(player.rot)*(player.r+10);
  const by = player.y + Math.sin(player.rot)*(player.r+10);

  world.bullets.push({ x:bx, y:by, vx:Math.cos(player.rot)*CFG.bulletSpeed, vy:Math.sin(player.rot)*CFG.bulletSpeed, birth:now, trail:[] });

  // apply small physical shove (fraction of recoil) so player doesn't butter-slide
  const shove = recoil * CFG.recoilVelocityFactor;
  player.vx -= Math.cos(player.rot) * shove;
  player.vy -= Math.sin(player.rot) * shove;

  // apply aim kick (tiny angle), which decays each frame
  const kick = (Math.random()*2 - 1) * (recoil * 0.02) + (recoil * CFG.recoilAimKick);
  player.aimKick += kick;

  // muzzle visual
  world.fx.push({ type:'muzzle', x:bx, y:by, rot:player.rot, birth:now, lifeMs:120 });
}

function impactFX(x,y, now){
  world.timeFreezeUntil = now + CFG.hitPauseMs; // micro freeze
  world.shakeMag = 1.0 * CFG.impactShake; world.shakeT = now + 130;
  world.fx.push({ type:'impact', x, y, birth:now, lifeMs:240 });
  world.dmg.push({ x, y, baseY:y, txt:'34', birth:now, alpha:1 });
}

/* ===== HELPERS ===== */
function lerp(a,b,t){ return a + (b-a)*t; }
function clamp01(v){ return v<0?0:v>1?1:v; }
function angleLerp(a,b,t){ let d=(b-a)%(Math.PI*2); if(d>Math.PI) d-=Math.PI*2; if(d<-Math.PI) d+=Math.PI*2; return a + d*t; }

/* ===== RENDER ===== */
function draw(now){
  // world-to-screen translate: center camera and apply shake
  const shaking = now < world.shakeT;
  const sx = shaking ? (Math.random()*2-1)*world.shakeMag : 0;
  const sy = shaking ? (Math.random()*2-1)*world.shakeMag : 0;

  ctx.save();
  ctx.translate(-camera.x + sx, -camera.y + sy);

  // background (dirt/street)
  ctx.fillStyle = '#0d0f12';
  ctx.fillRect(camera.x, camera.y, camera.w, camera.h);
  // draw tiles (floor/wall)
  for(let ty=0; ty<MAP.rows; ty++){
    for(let tx=0; tx<MAP.cols; tx++){
      const tile = MAP.tiles[ty][tx];
      const px = tx*CFG.tileSize, py = ty*CFG.tileSize;
      if(tile===1){
        // wall
        ctx.fillStyle = '#24282c';
        ctx.fillRect(px,py,CFG.tileSize,CFG.tileSize);
        ctx.strokeStyle = '#1c1f22'; ctx.lineWidth=2; ctx.strokeRect(px,py,CFG.tileSize,CFG.tileSize);
      } else {
        // road / dirt
        ctx.fillStyle = '#16181b';
        ctx.fillRect(px,py,CFG.tileSize,CFG.tileSize);
        if((tx+ty)%2===0){ ctx.globalAlpha=0.02; ctx.fillStyle='#ffffff'; ctx.fillRect(px,py,CFG.tileSize,CFG.tileSize); ctx.globalAlpha=1; }
      }
    }
  }

  // bullets + hybrid trail (same idea as r7)
  for(const b of world.bullets){
    for(let i=0;i<b.trail.length;i++){
      const p=b.trail[i], a=Math.max(0,1 - i*CFG.trailFade);
      ctx.globalAlpha = 0.18 * a; ctx.strokeStyle='#b9c7d6'; ctx.lineWidth = 2 - i*0.25;
      ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(i? b.trail[i-1].x : b.x, i? b.trail[i-1].y : b.y); ctx.stroke();
      ctx.globalAlpha = 0.10 * a; ctx.strokeStyle = '#dfe9ff'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(i? b.trail[i-1].x : b.x, i? b.trail[i-1].y : b.y); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle='#e9f1ff'; ctx.beginPath(); ctx.arc(b.x,b.y,2.3,0,Math.PI*2); ctx.fill();
  }

  // fx: muzzle & impact
  for(const f of world.fx){
    const age = now - f.birth;
    if(f.type==='impact'){
      const a = Math.max(0, 1 - age/240);
      ctx.globalAlpha = a; ctx.strokeStyle='#9ad1ff'; ctx.lineWidth=2;
      ctx.beginPath(); ctx.arc(f.x,f.y, 6+age*0.04, 0, Math.PI*2); ctx.stroke(); ctx.globalAlpha=1;
    }
    if(f.type==='muzzle'){
      const life = Math.max(0, 1 - age/120); if(life<=0) continue;
      ctx.save(); ctx.translate(f.x,f.y); ctx.rotate(f.rot);
      ctx.globalAlpha = 0.33 * life; ctx.fillStyle = '#f7f3d4';
      ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(16+age*0.04, 3.5); ctx.lineTo(16+age*0.04,-3.5); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 0.55 * life; ctx.fillStyle = '#fff6c3'; ctx.fillRect(0,-1.2,8.5,2.4);
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

  // player (draw at world coords)
  ctx.save(); ctx.translate(player.x, player.y); ctx.rotate(player.rot);
  ctx.fillStyle='#e7ecf2'; ctx.beginPath(); ctx.arc(0,0,player.r,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle='#87a6ff'; ctx.lineWidth=3; ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(player.r+10,0); ctx.stroke();
  ctx.restore();

  // damage numbers
  for(const d of world.dmg){
    ctx.globalAlpha = d.alpha*0.9; ctx.fillStyle = '#e8ecf2';
    ctx.font = '600 12px -apple-system, system-ui, sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(d.txt, d.x, d.y); ctx.globalAlpha = 1;
  }

  ctx.restore(); // end camera translate
}