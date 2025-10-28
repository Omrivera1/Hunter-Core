/* HUNTER-CORE r13 -- Grandeur Restore
   - Fast bullets + longer life + impact FX
   - Parallax textured floor + vignette gradient
   - Solid walls/cover + player & bullet collision
   - Smooth aim + L2 precision zoom + grounded recoil
*/

const CFG = {
  // WORLD FEEL
  tile: 48,
  floorParallax: 0.6,
  vignette: true,

  // MOVEMENT
  accel: 1.05,
  friction: 0.90,
  maxSpeed: 7.6,

  // AIM FEEL
  rotFollowBase: 5.2,
  aimFilter: 0.22,
  aimGamma: 1.9,
  precisionFactor: 0.35, // while holding L2/LT

  // CAMERA
  zoomDefault: 1.00,
  zoomPrecision: 1.35,
  zoomLerp: 0.12,

  // BARREL
  barrelLen: 30,
  barrelWidth: 7,

  // BULLETS (AR-like by default)
  bulletSpeed: 2600/60,     // px per frame (~2600 px/s @60fps)
  bulletLife: 1.8,          // seconds
  trailPoints: 8,
  trailMinSeg2: 16,         // add trail point every 4 px
  trailAlpha: 0.18,

  // RECOIL (grounded)
  recoilVel: 0.22,
  recoilAimKick: 0.06,
  aimKickDecay: 0.86,

  // IMPACT FX
  sparkLife: 0.18,
  sparkCount: [6,10],

  // COLLISION SUBSTEPS (avoid tunneling)
  substeps: 3,

  // DUMMY
  dummyHP: 8
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

// ---------- World: map, walls ----------
const map = {
  w: Math.ceil(innerWidth/CFG.tile)+8,
  h: Math.ceil(innerHeight/CFG.tile)+8,
  walls: [] // array of {x,y,w,h}
};
// layout a little arena with cover blocks
function buildArena(){
  map.walls.length=0;
  const T=CFG.tile;
  // outer ring
  map.walls.push({x:-T*2,y:-T*2,w:T*2,h:innerHeight+T*4});
  map.walls.push({x:innerWidth,y:-T*2,w:T*2,h:innerHeight+T*4});
  map.walls.push({x:-T*2,y:-T*2,w:innerWidth+T*4,h:T*2});
  map.walls.push({x:-T*2,y:innerHeight,w:innerWidth+T*4,h:T*2});
  // inner cover
  const cx=innerWidth/2, cy=innerHeight/2;
  map.walls.push({x:cx-180,y:cy-40,w:80,h:32});
  map.walls.push({x:cx+160,y:cy-12,w:56,h:56});
  map.walls.push({x:cx+300,y:cy-110,w:46,h:120});
}
buildArena();

// ---------- Entities ----------
const cam = {zoom:CFG.zoomDefault, target:CFG.zoomDefault};
const player={
  x: innerWidth/2, y: innerHeight/2,
  vx:0, vy:0, rot:0, aimX:1, aimY:0, lastFire:false
};
const bullets = [];
const sparks = []; // impact FX

const dummy = {x: innerWidth*0.68, y: innerHeight*0.42, w:44, h:34, hp: CFG.dummyHP};

// ---------- Math helpers ----------
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function lerp(a,b,t){return a+(b-a)*t;}
function sign(v){return v<0?-1:1;}
function AABB(a,b){return a.x<a.x2 && b.x<b.x2 && a.y<a.y2 && b.y<b.y2;}
function rectsOverlap(r1,r2){
  return !(r2.x>r1.x+r1.w || r2.x+r2.w<r1.x || r2.y>r1.y+r1.h || r2.y+r2.h<r1.y);
}

// ---------- Collision: player vs walls ----------
function slideAgainstWalls(x,y,r, vx,vy){
  // capsule approximated as circle
  const me={x:x-r,y:y-r,w:r*2,h:r*2};
  // try x
  let nx=x+vx, ny=y;
  me.x = nx-r;
  for(const w of map.walls){
    if(rectsOverlap(me,w)){ nx = vx>0 ? w.x - r : w.x + w.w + r; vx=0; me.x=nx-r; }
  }
  // try y
  me.y = ny-r; me.x = nx-r;
  ny = y+vy;
  me.y = ny-r;
  for(const w of map.walls){
    if(rectsOverlap(me,w)){ ny = vy>0 ? w.y - r : w.y + w.h + r; vy=0; me.y=ny-r; }
  }
  return {x:nx,y:ny,vx,vy};
}

// ---------- Update ----------
let last=performance.now();
function tick(){
  requestAnimationFrame(tick);
  const now=performance.now();
  let dt=(now-last)/1000; last=now;
  dt=Math.min(dt,1/30);

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

  // integrate with wall sliding (substeps)
  let vx=player.vx*dt*CFG.substeps, vy=player.vy*dt*CFG.substeps;
  let nx=player.x, ny=player.y;
  for(let i=0;i<CFG.substeps;i++){
    const res = slideAgainstWalls(nx,ny,14, vx,vy);
    nx=res.x; ny=res.y; vx=res.vx; vy=res.vy;
  }
  player.x=nx; player.y=ny; player.vx=vx/(dt*CFG.substeps); player.vy=vy/(dt*CFG.substeps);

  // aim filtering + rotation smoothing
  let ax=input.rx, ay=input.ry;
  const amag=Math.hypot(ax,ay);
  if(amag>0.01){
    const f=CFG.aimFilter*(precise?CFG.precisionFactor:1);
    player.aimX = lerp(player.aimX, ax/amag, f);
    player.aimY = lerp(player.aimY, ay/amag, f);
    const targ = Math.atan2(player.aimY,player.aimX);
    let d=((targ-player.rot+Math.PI*3)%(Math.PI*2))-Math.PI;
    player.rot += d * (CFG.rotFollowBase*(precise?CFG.precisionFactor:1)) * dt;
  }

  cam.target = precise?CFG.zoomPrecision:CFG.zoomDefault;
  cam.zoom = lerp(cam.zoom, cam.target, CFG.zoomLerp);

  // fire (semi; edge detect)
  const pressed = input.fire && !player.lastFire;
  player.lastFire = input.fire;
  if(pressed){
    const len = CFG.barrelLen*(precise?1.12:1.0);
    const bx = player.x + Math.cos(player.rot)*len;
    const by = player.y + Math.sin(player.rot)*len;
    const spx = Math.cos(player.rot)*CFG.bulletSpeed;
    const spy = Math.sin(player.rot)*CFG.bulletSpeed;
    bullets.push({x:bx,y:by,vx:spx,vy:spy, life:CFG.bulletLife, trail:[{x:bx,y:by}]});
    // grounded recoil
    player.vx -= Math.cos(player.rot)*CFG.recoilVel;
    player.vy -= Math.sin(player.rot)*CFG.recoilVel;
  }

  // bullets
  for(let i=bullets.length-1;i>=0;i--){
    const b=bullets[i];
    // substep to prevent tunneling through thin walls
    let steps = CFG.substeps;
    let stepx = (b.vx*dt)/steps, stepy=(b.vy*dt)/steps;
    let hit=false, hx=b.x, hy=b.y;
    for(let s=0;s<steps;s++){
      const nx=b.x+stepx, ny=b.y+stepy;
      // collide vs walls
      for(const w of map.walls){
        if(nx>=w.x && nx<=w.x+w.w && ny>=w.y && ny<=w.y+w.h){ hit=true; hx=nx; hy=ny; break; }
      }
      b.x=nx; b.y=ny;
      if(hit) break;
    }
    b.life-=dt;

    // trail
    const lp=b.trail[b.trail.length-1];
    const dx=b.x-lp.x, dy=b.y-lp.y;
    if(dx*dx+dy*dy>CFG.trailMinSeg2){
      b.trail.push({x:b.x,y:b.y});
      if(b.trail.length>CFG.trailPoints) b.trail.shift();
    }

    // dummy collision (center point)
    if(!hit && (b.x>dummy.x-dummy.w/2 && b.x<dummy.x+dummy.w/2 && b.y>dummy.y-dummy.h/2 && b.y<dummy.y+dummy.h/2)){
      hit=true; hx=b.x; hy=b.y; dummy.hp=Math.max(0, dummy.hp-1);
    }

    if(hit || b.life<=0 || b.x<-200 || b.y<-200 || b.x>innerWidth+200 || b.y>innerHeight+200){
      // spawn sparks
      const n = Math.floor( lerp(CFG.sparkCount[0], CFG.sparkCount[1], Math.random()) );
      for(let k=0;k<n;k++){
        const a=Math.random()*Math.PI*2, sp= (400+Math.random()*400)/60;
        sparks.push({x:hx,y:hy,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,life:CFG.sparkLife});
      }
      bullets.splice(i,1);
    }
  }

  // sparks
  for(let i=sparks.length-1;i>=0;i--){
    const s=sparks[i];
    s.x+=s.vx*dt; s.y+=s.vy*dt;
    s.vx*=0.92; s.vy*=0.92;
    s.life-=dt;
    if(s.life<=0) sparks.splice(i,1);
  }

  render();
}

// ---------- Render ----------
function render(){
  // background gradient
  if(CFG.vignette){
    const g=ctx.createLinearGradient(0,0,0,innerHeight);
    g.addColorStop(0,'#0e1118'); g.addColorStop(1,'#0b0d13');
    ctx.fillStyle=g; ctx.fillRect(0,0,innerWidth,innerHeight);
  }else{
    ctx.fillStyle='#0d1016'; ctx.fillRect(0,0,innerWidth,innerHeight);
  }

  // parallax floor checker
  const T=CFG.tile, p=CFG.floorParallax;
  const ox = -((player.x*p)%T), oy = -((player.y*p)%T);
  for(let y=oy - T; y<innerHeight+T; y+=T){
    for(let x=ox - T; x<innerWidth+T; x+=T){
      const ix=((x-ox)/T)|0, iy=((y-oy)/T)|0;
      ctx.fillStyle = ((ix+iy)&1)?'#121622':'#14192a';
      ctx.fillRect(x,y,T,T);
    }
  }

  // zoom transform
  ctx.save();
  ctx.translate(innerWidth/2, innerHeight/2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-innerWidth/2, -innerHeight/2);

  // walls
  ctx.fillStyle='#1c2335';
  for(const w of map.walls) ctx.fillRect(w.x,w.y,w.w,w.h);
  ctx.strokeStyle='rgba(255,255,255,0.06)';
  ctx.lineWidth=1;
  for(const w of map.walls){ ctx.strokeRect(w.x+0.5,w.y+0.5,w.w-1,w.h-1); }

  // dummy
  ctx.strokeStyle='#cfe0ff'; ctx.lineWidth=2;
  ctx.strokeRect(dummy.x-dummy.w/2, dummy.y-dummy.h/2, dummy.w, dummy.h);
  for(let i=0;i<dummy.hp;i++){
    ctx.fillStyle='#ff6b6b';
    ctx.fillRect(dummy.x-30+i*10, dummy.y-dummy.h/2-12, 6, 4);
  }

  // bullets (trail then head)
  for(const b of bullets){
    for(let i=1;i<b.trail.length;i++){
      const a=b.trail[i-1], d=b.trail[i];
      const t=i/b.trail.length;
      ctx.strokeStyle=`rgba(122,168,255,${(1-t)*(1-CFG.trailAlpha)+0.12})`;
      ctx.lineWidth = 3*(1-t)+1;
      ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(d.x,d.y); ctx.stroke();
    }
    ctx.fillStyle='#d9e6ff';
    ctx.beginPath(); ctx.arc(b.x,b.y,3,0,Math.PI*2); ctx.fill();
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

  ctx.restore();

  // HUD
  ctx.fillStyle='rgba(255,255,255,0.6)';
  ctx.font='12px system-ui, -apple-system, Segoe UI, Roboto';
  ctx.fillText(gpOK?'Controller OK':'Controller ?', 14, innerHeight-14);
}

// ---------- Boot ----------
requestAnimationFrame(tick);