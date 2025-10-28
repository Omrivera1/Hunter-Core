/* HUNTER-CORE r15 -- Feel Rehab
   - Faster player movement
   - Recoil restored (shove + aim-kick decay)
   - Enemy reacts: flash, knockback, HP pips, damage numbers
   - Impact-only screenshake + micro hit-pause
   - Fast bullets + long trails
   - Smooth aim, L2 precision zoom, walls/collision retained
*/

const CFG = {
  // WORLD / LOOK
  tile: 48,
  floorParallax: 0.6,
  vignette: true,

  // MOVEMENT (faster)
  accel: 1.45,
  friction: 0.88,
  maxSpeed: 10.2,

  // AIM FEEL
  rotFollowBase: 5.2,
  aimFilter: 0.22,
  aimGamma: 1.9,
  precisionFactor: 0.35,   // while L2/LT

  // CAMERA
  zoomDefault: 1.00,
  zoomPrecision: 1.35,
  zoomLerp: 0.12,

  // BARREL
  barrelLen: 30,
  barrelWidth: 7,

  // BULLETS -- px/second (FAST) + long life + long trail
  bulletSpeed: 4200,
  bulletLife: 3.2,          // seconds
  trailPoints: 24,
  trailMinSeg2: 9,          // record trail every ~3px
  trailAlpha: 0.10,

  // RECOIL (grounded) -- restored
  recoilVel: 0.48,          // physical shove
  recoilAimKick: 0.055,     // radians added then decays
  aimKickDecay: 0.86,

  // IMPACT FX
  sparkLife: 0.22,
  sparkCount: [8,14],
  hitPauseMs: 65,           // micro freeze on hit
  screenShake: 1.6,         // impact-only

  // COLLISION SUBSTEPS
  substeps: 3
};

// ---------- Canvas ----------
const c = document.getElementById('c');
const ctx = c.getContext('2d', {alpha:false});
function resize(){
  const dpr = devicePixelRatio || 1;
  c.width = innerWidth * dpr;
  c.height = innerHeight * dpr;
  ctx.setTransform(1,0,0,1,0,0);
  ctx.scale(dpr,dpr);
}
addEventListener('resize', resize, {passive:true}); resize();

// ---------- Input ----------
const input = {lx:0,ly:0,rx:0,ry:0,fire:false};
const keys = {};
addEventListener('keydown',e=>keys[e.code]=true);
addEventListener('keyup',e=>keys[e.code]=false);
let precise=false, gpOK=false;
addEventListener('gamepadconnected',()=>gpOK=true);
addEventListener('gamepaddisconnected',()=>gpOK=false);

function dead(v){const d=0.16; return Math.abs(v)<d?0:v;}
function curve(v,g){const s=Math.sign(v),a=Math.abs(v);return s*Math.pow(a,g);}
function pollPad(){
  const gp = navigator.getGamepads?.()[0];
  if(!gp){
    input.lx=(keys['KeyD']?1:0)-(keys['KeyA']?1:0);
    input.ly=(keys['KeyS']?1:0)-(keys['KeyW']?1:0);
    input.rx=0; input.ry=0;
    input.fire=!!keys['Space']; precise=!!(keys['ShiftLeft']||keys['ShiftRight']);
    return;
  }
  input.lx=dead(gp.axes[0]); input.ly=dead(gp.axes[1]);
  input.rx=curve(dead(gp.axes[2]), CFG.aimGamma);
  input.ry=curve(dead(gp.axes[3]), CFG.aimGamma);
  input.fire=!!gp.buttons?.[7]?.pressed || !!keys['Space']; // RT/Space
  precise=!!gp.buttons?.[6]?.pressed; // LT
}

// ---------- World ----------
const map = { walls: [] };
function buildArena(){
  map.walls.length=0;
  const T=CFG.tile;
  // outer ring
  map.walls.push({x:-T*2,y:-T*2,w:T*2,h:innerHeight+T*4});
  map.walls.push({x:innerWidth,y:-T*2,w:T*2,h:innerHeight+T*4});
  map.walls.push({x:-T*2,y:-T*2,w:innerWidth+T*4,h:T*2});
  map.walls.push({x:-T*2,y:innerHeight,w:innerWidth+T*4,h:T*2});
  // inner cover (mid-block)
  const cx=innerWidth/2, cy=innerHeight/2;
  map.walls.push({x:cx-180,y:cy-40,w:88,h:36});
  map.walls.push({x:cx+160,y:cy-12,w:60,h:60});
  map.walls.push({x:cx+300,y:cy-110,w:50,h:124});
}
buildArena();

// ---------- Entities ----------
const cam = {zoom:CFG.zoomDefault, target:CFG.zoomDefault};
const world = { timeFreezeUntil:0, shakeUntil:0, shakeMag:0 };

const player={
  x: innerWidth/2, y: innerHeight/2,
  vx:0, vy:0, rot:0, aimX:1, aimY:0, lastFire:false,
  aimKick:0
};

const bullets=[], sparks=[], dmgNums=[];
const enemy = {
  x: innerWidth*0.68, y: innerHeight*0.42, w:44, h:34,
  hpMax: 10, hp: 10, hurtUntil: 0, flashUntil: 0
};

// ---------- Helpers ----------
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function lerp(a,b,t){return a+(b-a)*t;}
function rectsOverlap(r1,r2){return !(r2.x>r1.x+r1.w || r2.x+r2.w<r1.x || r2.y>r1.y+r1.h || r2.y+r2.h<r1.y);}
function nowMs(){return performance.now();}

// player vs walls sliding
function slideAgainstWalls(x,y,r, vx,vy){
  const me={x:x-r,y:y-r,w:r*2,h:r*2};
  // x
  let nx=x+vx, ny=y;
  me.x = nx-r;
  for(const w of map.walls){
    if(rectsOverlap(me,w)){ nx = vx>0 ? w.x - r : w.x + w.w + r; vx=0; me.x=nx-r; }
  }
  // y
  ny = y+vy; me.y = ny-r; me.x = nx-r;
  for(const w of map.walls){
    if(rectsOverlap(me,w)){ ny = vy>0 ? w.y - r : w.y + w.h + r; vy=0; me.y=ny-r; }
  }
  return {x:nx,y:ny,vx,vy};
}

function enemyAABB(){
  return {x: enemy.x - enemy.w/2, y: enemy.y - enemy.h/2, w: enemy.w, h: enemy.h};
}

function spawnSparks(x,y){
  const n = Math.floor( ((CFG.sparkCount[1]-CFG.sparkCount[0])*Math.random()) + CFG.sparkCount[0] );
  for(let k=0;k<n;k++){
    const a=Math.random()*Math.PI*2, sp= (500+Math.random()*500); // px/s
    sparks.push({x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,life:CFG.sparkLife});
  }
}

function addDmg(x,y,txt){
  dmgNums.push({x,y,txt,vy:-24, alpha:1, birth:nowMs()});
}

// ---------- Update ----------
let last=performance.now();
function tick(){
  requestAnimationFrame(tick);
  const t=performance.now();
  let dt=(t-last)/1000; last=t;
  dt=Math.min(dt,1/30);

  const frozen = t < world.timeFreezeUntil;
  const activeDt = frozen ? 0 : dt;

  pollPad();

  // movement
  const mMag=Math.hypot(input.lx,input.ly);
  if(mMag>0){
    player.vx += (input.lx/mMag)*CFG.accel;
    player.vy += (input.ly/mMag)*CFG.accel;
  }
  player.vx*=CFG.friction; player.vy*=CFG.friction;
  const sp=Math.hypot(player.vx,player.vy);
  if(sp>CFG.maxSpeed){ const s=CFG.maxSpeed/(sp+1e-6); player.vx*=s; player.vy*=s; }

  // integrate with wall slide (substeps)
  let stepX=player.vx*activeDt/CFG.substeps, stepY=player.vy*activeDt/CFG.substeps;
  let nx=player.x, ny=player.y, vx=stepX, vy=stepY;
  for(let i=0;i<CFG.substeps;i++){
    const res = slideAgainstWalls(nx,ny,14, vx,vy);
    nx=res.x; ny=res.y; vx=res.vx; vy=res.vy;
  }
  player.x=nx; player.y=ny;
  player.vx=vx*CFG.substeps/(activeDt||1); player.vy=vy*CFG.substeps/(activeDt||1);

  // aim smoothing + aim kick
  let ax=input.rx, ay=input.ry;
  const amag=Math.hypot(ax,ay);
  if(amag>0.01){
    const f=CFG.aimFilter*(precise?CFG.precisionFactor:1);
    player.aimX = lerp(player.aimX, ax/amag, f);
    player.aimY = lerp(player.aimY, ay/amag, f);
    const targ = Math.atan2(player.aimY,player.aimX) + player.aimKick;
    let d=((targ-player.rot+Math.PI*3)%(Math.PI*2))-Math.PI;
    player.rot += d * (CFG.rotFollowBase*(precise?CFG.precisionFactor:1)) * activeDt;
  }
  // decay aim kick
  if (Math.abs(player.aimKick) > 1e-4) player.aimKick *= CFG.aimKickDecay;

  cam.target = precise?CFG.zoomPrecision:CFG.zoomDefault;
  cam.zoom = lerp(cam.zoom, cam.target, CFG.zoomLerp);

  // fire (semi; edge detect)
  const pressed = input.fire && !player.lastFire;
  player.lastFire = input.fire;
  if(pressed && !frozen){
    const len = CFG.barrelLen*(precise?1.12:1.0);
    const bx = player.x + Math.cos(player.rot)*len;
    const by = player.y + Math.sin(player.rot)*len;
    // px/sec velocity
    const spx = Math.cos(player.rot)*CFG.bulletSpeed;
    const spy = Math.sin(player.rot)*CFG.bulletSpeed;
    bullets.push({x:bx,y:by,vx:spx,vy:spy, life:CFG.bulletLife, trail:[{x:bx,y:by}]});
    // recoil (physical + aim kick)
    player.vx -= Math.cos(player.rot)*CFG.recoilVel;
    player.vy -= Math.sin(player.rot)*CFG.recoilVel;
    player.aimKick += (Math.random()*2-1)*0.01 + CFG.recoilAimKick;
  }

  // bullets (px/sec integration) + collision
  const eBox = enemyAABB();
  for(let i=bullets.length-1;i>=0;i--){
    const b=bullets[i];
    let steps = CFG.substeps;
    let stepx = (b.vx*activeDt)/steps, stepy=(b.vy*activeDt)/steps;
    let hit=false, hx=b.x, hy=b.y, hitEnemy=false;

    for(let s=0;s<steps;s++){
      const nx=b.x+stepx, ny=b.y+stepy;
      // hit walls?
      for(const w of map.walls){
        if(nx>=w.x && nx<=w.x+w.w && ny>=w.y && ny<=w.y+w.h){ hit=true; hx=nx; hy=ny; break; }
      }
      if(hit){ b.x=nx; b.y=ny; break; }

      // hit enemy?
      if(nx>=eBox.x && nx<=eBox.x+eBox.w && ny>=eBox.y && ny<=eBox.y+eBox.h){
        hit=true; hitEnemy=true; hx=nx; hy=ny; b.x=nx; b.y=ny; break;
      }

      b.x=nx; b.y=ny;
    }

    if(!frozen){
      b.life-=dt;
      // trail accumulation
      const lp=b.trail[b.trail.length-1];
      const dx=b.x-lp.x, dy=b.y-lp.y;
      if(dx*dx+dy*dy>CFG.trailMinSeg2){
        b.trail.push({x:b.x,y:b.y});
        if(b.trail.length>CFG.trailPoints) b.trail.shift();
      }
    }

    if(hit || b.life<=0 || b.x<-400 || b.y<-400 || b.x>innerWidth+400 || b.y>innerHeight+400){
      spawnSparks(hx,hy);

      if(hitEnemy){
        // enemy reactions
        enemy.hp = Math.max(0, enemy.hp - 1);
        enemy.flashUntil = t + 120;
        enemy.hurtUntil = t + 180;
        // enemy knockback (small)
        const kb = 1800; // px/sec
        const dirx = Math.cos(player.rot), diry = Math.sin(player.rot);
        enemy.x += dirx * (kb * dt * 0.25);
        enemy.y += diry * (kb * dt * 0.25);
        // hit-pause & screenshake
        world.timeFreezeUntil = t + CFG.hitPauseMs;
        world.shakeMag = CFG.screenShake; world.shakeUntil = t + 150;
        // damage number
        addDmg(hx, hy, '34');
        // clamp enemy inside arena (rough)
        const cl = {x:0,y:0,w:innerWidth,h:innerHeight};
        enemy.x = clamp(enemy.x, cl.x + enemy.w/2, cl.x+cl.w - enemy.w/2);
        enemy.y = clamp(enemy.y, cl.y + enemy.h/2, cl.y+cl.h - enemy.h/2);

        // respawn if dead
        if(enemy.hp <= 0){
          setTimeout(()=>{
            enemy.hp = enemy.hpMax;
            enemy.x = innerWidth*0.68; enemy.y = innerHeight*0.42;
          }, 450);
        }
      }

      bullets.splice(i,1);
    }
  }

  // sparks
  for(let i=sparks.length-1;i>=0;i--){
    const s=sparks[i], dtlim=Math.min(activeDt,0.033);
    s.x+=s.vx*dtlim; s.y+=s.vy*dtlim;
    s.vx*=0.92; s.vy*=0.92;
    s.life-=dtlim;
    if(s.life<=0) sparks.splice(i,1);
  }

  // damage numbers
  for(let i=dmgNums.length-1;i>=0;i--){
    const d=dmgNums[i];
    const age = (t - d.birth);
    d.y += (d.vy * (activeDt||0)); d.vy *= 0.98;
    d.alpha = Math.max(0, 1 - age/550);
    if(age>550) dmgNums.splice(i,1);
  }

  render(t);
}

// ---------- Render ----------
function render(t){
  // gradient/vignette
  if(CFG.vignette){
    const g=ctx.createLinearGradient(0,0,0,innerHeight);
    g.addColorStop(0,'#0e1118'); g.addColorStop(1,'#0b0d13');
    ctx.fillStyle=g; ctx.fillRect(0,0,innerWidth,innerHeight);
  }else{
    ctx.fillStyle='#0d1016'; ctx.fillRect(0,0,innerWidth,innerHeight);
  }

  // parallax floor (moves with player to suggest space)
  const T=CFG.tile, p=CFG.floorParallax;
  const ox = -((player.x*p)%T), oy = -((player.y*p)%T);
  for(let y=oy - T; y<innerHeight+T; y+=T){
    for(let x=ox - T; x<innerWidth+T; x+=T){
      const ix=((x-ox)/T)|0, iy=((y-oy)/T)|0;
      ctx.fillStyle = ((ix+iy)&1)?'#121622':'#14192a';
      ctx.fillRect(x,y,T,T);
    }
  }

  // camera shake (impact only)
  const shaking = t < world.shakeUntil;
  const sx = shaking ? (Math.random()*2-1)*world.shakeMag : 0;
  const sy = shaking ? (Math.random()*2-1)*world.shakeMag : 0;

  // zoom + shake
  ctx.save();
  ctx.translate(innerWidth/2 + sx, innerHeight/2 + sy);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-innerWidth/2, -innerHeight/2);

  // walls
  ctx.fillStyle='#1c2335';
  for(const w of map.walls) ctx.fillRect(w.x,w.y,w.w,w.h);
  ctx.strokeStyle='rgba(255,255,255,0.06)';
  ctx.lineWidth=1;
  for(const w of map.walls){ ctx.strokeRect(w.x+0.5,w.y+0.5,w.w-1,w.h-1); }

  // enemy (flash when hit)
  const flashing = t < enemy.flashUntil;
  ctx.save();
  ctx.globalAlpha = flashing ? 1.0 : 1.0;
  ctx.strokeStyle = flashing ? '#ffffff' : '#cfe0ff';
  ctx.lineWidth = flashing ? 3 : 2;
  ctx.strokeRect(enemy.x-enemy.w/2, enemy.y-enemy.h/2, enemy.w, enemy.h);
  // HP pips
  for(let i=0;i<enemy.hp;i++){
    ctx.fillStyle='#ff6b6b';
    ctx.fillRect(enemy.x-30+i*10, enemy.y-enemy.h/2-12, 6, 4);
  }
  ctx.restore();

  // bullets (trail then head)
  for(const b of bullets){
    for(let i=1;i<b.trail.length;i++){
      const a=b.trail[i-1], d=b.trail[i];
      const tseg=i/b.trail.length;
      ctx.strokeStyle=`rgba(130,170,255,${(1-tseg)*(1-CFG.trailAlpha)+0.14})`;
      ctx.lineWidth = 3*(1-tseg)+1;
      ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(d.x,d.y); ctx.stroke();
    }
    ctx.fillStyle='#e4eeff';
    ctx.beginPath(); ctx.arc(b.x,b.y,3.2,0,Math.PI*2); ctx.fill();
  }

  // sparks
  for(const s of sparks){
    const a = Math.max(0,s.life/CFG.sparkLife);
    ctx.strokeStyle=`rgba(255,210,120,${a})`;
    ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - s.vx*0.05, s.y - s.vy*0.05); ctx.stroke();
  }

  // player
  ctx.fillStyle='#e8ecf9';
  ctx.beginPath(); ctx.arc(player.x,player.y,16,0,Math.PI*2); ctx.fill();

  // barrel
  const len = CFG.barrelLen*(precise?1.12:1);
  const bx = player.x + Math.cos(player.rot)*len;
  const by = player.y + Math.sin(player.rot)*len;
  ctx.strokeStyle='#7aa8ff';
  ctx.lineWidth=CFG.barrelWidth; ctx.lineCap='round';
  ctx.beginPath(); ctx.moveTo(player.x,player.y); ctx.lineTo(bx,by); ctx.stroke();
  ctx.fillStyle='rgba(255,255,255,0.8)';
  ctx.beginPath(); ctx.arc(bx,by,2.6,0,Math.PI*2); ctx.fill();

  // damage numbers
  for(const d of dmgNums){
    ctx.globalAlpha = d.alpha*0.95;
    ctx.fillStyle = '#e8ecf2';
    ctx.font = '600 12px -apple-system, system-ui, sans-serif';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(d.txt, d.x, d.y);
    ctx.globalAlpha = 1;
  }

  ctx.restore();

  // HUD
  ctx.fillStyle='rgba(255,255,255,0.6)';
  ctx.font='12px system-ui, -apple-system, Segoe UI, Roboto';
  ctx.fillText(gpOK?'Controller OK':'Controller ?', 14, innerHeight-14);
}

// ---------- Boot ----------
requestAnimationFrame(tick);