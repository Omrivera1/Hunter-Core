/* HUNTER-CORE r23
   - Scroll camera / big arena
   - Enemies: zombie capsules (wander → alert/chase), collide with player & world
   - Death: blood burst + corpse decal; remove on fade
   - Impacts: blood on enemy; sparks on obstacles (only)
   - Micro camera shake on shotgun & strong impacts
   - Floor decals: blood splats, debris puffs
   - HUD: fire mode; simple options
   - Input: L1 toggle fire mode; L3 sprint; R2/R1 fire
*/

(() => {
  // ---------- Canvas ----------
  const c = document.getElementById('c') || (() => {
    const el = document.createElement('canvas'); el.id='c'; document.body.appendChild(el); return el;
  })();
  const ctx = c.getContext('2d', { alpha:false });
  const DPR = Math.max(1, Math.min(3, devicePixelRatio||1));
  function resize(){ c.width=innerWidth*DPR; c.height=innerHeight*DPR; c.style.width=innerWidth+'px'; c.style.height=innerHeight+'px'; ctx.setTransform(DPR,0,0,DPR,0,0); }
  addEventListener('resize',resize); resize();

  // ---------- Style ----------
  const PAL = {
    bgA:'#0e1522', bgB:'#101a2b',
    grid1:'rgba(255,255,255,0.03)', grid2:'rgba(255,255,255,0.015)',
    player:'#e7eefc', playerEdge:'#90a7ff', barrel:'#d7e1ff',
    muzzle:'#ffe6ad',
    tracerHot:'#ffd7a1', tracerFade:'rgba(255,140,40,0)',
    sparkHot:'#ffd48a', sparkCool:'#ff7a52',
    bloodA:'#c22727', bloodB:'#7a1212',
    enemyBody:'#4b5a6f', enemyEdge:'#b2e2ff', enemyHead:'#d7ecff',
    hud:'rgba(255,255,255,0.6)'
  };

  // ---------- World / Camera ----------
  const world = {
    W: 3600, H: 2400, grid: 64, bounds: 64,
    friction: 8, accel: 1000,
    baseSpeed: 360, sprint: 1.55,
    recoilPush: 120,
    obstacles: []
  };

  // obstacles (rects + pillars)
  const rect = (x,y,w,h)=>({type:'rect',x,y,w,h});
  const pill = (x,y,r)=>({type:'pill',x,y,r});
  world.obstacles.push(
    rect(900,520,260,80), rect(1480,380,120,360),
    rect(2100,780,360,90), rect(2550,400,160,120),
    rect(2900,1200,220,100), rect(800,1400,300,90),
    rect(1600,1600,500,80), rect(2200,1840,160,380),
    rect(400,1900,300,120), rect(3000,600,90,420),
    pill(1200,1000,36), pill(1750,900,42), pill(2450,1350,38),
    pill(3100,1550,46), pill(600,600,32)
  );

  const cam = {x:0,y:0, shake:0, shx:0, shy:0};

  // ---------- Input ----------
  const PAD = {LX:0,LY:1,RX:2,RY:3,L1:4,R1:5,L2:6,R2:7,SELECT:8,START:9,L3:10,R3:11};
  const input = { move:{x:0,y:0}, aim:{x:1,y:0}, fire:false, l3:false, _l1:false };
  function pad(){ const a=navigator.getGamepads?.()||[]; for(const p of a) if(p) return p; return null; }
  function dead(v,d=0.15){ return Math.abs(v)<d?0:v; }
  function readInput(){
    const p=pad(); if(!p){ input.move.x=input.move.y=0; input.fire=false; return; }
    const lx=dead(p.axes[PAD.LX]||0), ly=dead(p.axes[PAD.LY]||0);
    const rx=dead(p.axes[PAD.RX]||0), ry=dead(p.axes[PAD.RY]||0);
    input.move.x=lx; input.move.y=ly;
    if(rx||ry){ input.aim.x=rx; input.aim.y=ry; }
    input.fire = (p.buttons[PAD.R2]?.value??0)>0.5 || !!p.buttons[PAD.R1]?.pressed;
    input.l3 = !!p.buttons[PAD.L3]?.pressed;
    const l1 = !!p.buttons[PAD.L1]?.pressed;
    if(l1 && !input._l1) cycleFireMode();
    input._l1 = l1;
  }

  // ---------- Player ----------
  const player = { x:world.W/2, y:world.H/2, vx:0, vy:0, r:18, ang:0, aimSmooth:0.18 };

  // ---------- Enemies ----------
  const enemies=[];
  function spawnEnemies(n=9){
    enemies.length=0;
    for(let i=0;i<n;i++){
      enemies.push({
        x: 300+Math.random()*(world.W-600),
        y: 300+Math.random()*(world.H-600),
        vx:0, vy:0, w:58, h:50, r:14,
        hp:70, maxHp:70, alive:true, fade:0,
        // brain
        state:'wander', tw:0, wx:0, wy:0, sight:520
      });
    }
  }
  spawnEnemies();

  // ---------- Weapon / FX ----------
  const weapon = { mode:'auto', rpm:650, burstSize:3, burstGap:0.06, semiReady:true, cd:0, muzzle:0 };
  function cycleFireMode(){ weapon.mode = ({auto:'semi',semi:'burst',burst:'shotgun',shotgun:'auto'})[weapon.mode]; }

  const bullets=[], sparks=[], blood=[], decals=[];
  function fireRay(dx,dy){
    const sp=1600, life=1;
    const bx=player.x+Math.cos(player.ang)*player.r, by=player.y+Math.sin(player.ang)*player.r;
    bullets.push({x:bx,y:by,vx:dx*sp,vy:dy*sp,age:0,tail:0.06});
    // muzzle & recoil
    weapon.muzzle=0.05;
    const rec=Math.min(world.recoilPush, world.accel*0.14);
    player.vx-=dx*rec; player.vy-=dy*rec;
  }
  let burstQ=0, burstT=0, bdx=1, bdy=0;

  function shoot(dx,dy){
    if(weapon.cd>0) return;
    switch(weapon.mode){
      case 'auto': fireRay(dx,dy); weapon.cd=60/weapon.rpm; break;
      case 'semi': if(weapon.semiReady){ fireRay(dx,dy); weapon.semiReady=false; } weapon.cd=0.08; break;
      case 'burst':
        if(weapon.semiReady){ weapon.semiReady=false; burstQ=weapon.burstSize; burstT=0; bdx=dx; bdy=dy; }
        weapon.cd=0.02; break;
      case 'shotgun': {
        cam.shake += 0.5;
        const pellets=7, spread=0.13;
        for(let i=0;i<pellets;i++){ const a=Math.atan2(dy,dx)+(Math.random()*2-1)*spread; fireRay(Math.cos(a),Math.sin(a)); }
        weapon.cd=0.22; break;
      }
    }
  }

  function spawnSparks(x,y,ang){
    const N=12+(Math.random()*6|0);
    for(let i=0;i<N;i++){
      const a=ang+(Math.random()*0.8-0.4), sp=260+Math.random()*280;
      sparks.push({x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,age:0,life:0.18+Math.random()*0.25});
    }
    // debris decal
    decals.push({type:'debris',x,y,age:0,life:6,rot:Math.random()*6});
  }
  function spawnBlood(x,y,ang){
    const N=16+(Math.random()*10|0);
    for(let i=0;i<N;i++){
      const a=ang+(Math.random()*1.0-0.5), sp=180+Math.random()*260;
      blood.push({x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,age:0,life:0.25+Math.random()*0.35});
    }
    decals.push({type:'blood',x,y,age:0,life:14,rot:Math.random()*6});
  }

  // ---------- Collisions ----------
  function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
  function circleRectHit(cx,cy,r, rx,ry,rw,rh){
    const clx=clamp(cx,rx,rx+rw), cly=clamp(cy,ry,ry+rh);
    const dx=cx-clx, dy=cy-cly;
    return dx*dx+dy*dy<=r*r?{dx,dy,clx,cly}:null;
  }
  function aabb(ax,ay,aw,ah,bx,by,bw,bh){ return ax<bx+bw && ax+aw>bx && ay<by+bh && ay+ah>by; }

  // ---------- Update ----------
  let last=performance.now();
  function update(dt){
    readInput();

    // aim smoothing
    const targ=Math.atan2(input.aim.y,input.aim.x);
    let da=((targ-player.ang+Math.PI*3)%(Math.PI*2))-Math.PI; player.ang+=da*player.aimSmooth;

    // move
    const im=Math.hypot(input.move.x,input.move.y); const mx=im?input.move.x/im:0, my=im?input.move.y/im:0;
    const speed = world.baseSpeed * (input.l3 ? world.sprint : 1);
    const dvx=mx*speed, dvy=my*speed;
    player.vx += (dvx-player.vx)*Math.min(1,dt*10);
    player.vy += (dvy-player.vy)*Math.min(1,dt*10);
    const f=Math.exp(-world.friction*dt); player.vx*=f; player.vy*=f;

    player.x+=player.vx*dt; player.y+=player.vy*dt;

    // keep & collide player with world
    player.x=clamp(player.x, world.bounds+player.r, world.W-world.bounds-player.r);
    player.y=clamp(player.y, world.bounds+player.r, world.H-world.bounds-player.r);
    for(const o of world.obstacles){
      if(o.type==='rect'){
        const hit=circleRectHit(player.x,player.y,player.r, o.x,o.y,o.w,o.h);
        if(hit){
          const dx=player.x-hit.clx, dy=player.y-hit.cly;
          if(Math.abs(dx)>Math.abs(dy)){ player.x = dx>0? o.x+o.w+player.r : o.x-player.r; player.vx=0; }
          else { player.y = dy>0? o.y+o.h+player.r : o.y-player.r; player.vy=0; }
        }
      } else {
        const dx=player.x-o.x, dy=player.y-o.y, rr=player.r+o.r; if(dx*dx+dy*dy<rr*rr){
          const d=Math.hypot(dx,dy)||1, nx=dx/d, ny=dy/d; player.x=o.x+nx*rr; player.y=o.y+ny*rr;
          const vn=player.vx*nx+player.vy*ny; if(vn<0){ player.vx-=vn*nx; player.vy-=vn*ny; }
        }
      }
    }

    // camera follow + shake
    const vw=c.width/DPR, vh=c.height/DPR;
    cam.x = clamp(player.x - vw/2, 0, world.W-vw);
    cam.y = clamp(player.y - vh/2, 0, world.H-vh);
    if(cam.shake>0){ cam.shake=Math.max(0,cam.shake-dt*2); cam.shx=(Math.random()*2-1)*cam.shake*8; cam.shy=(Math.random()*2-1)*cam.shake*8; }
    else { cam.shx=cam.shy=0; }

    // firing cadence
    weapon.cd=Math.max(0,weapon.cd-dt); weapon.muzzle=Math.max(0,weapon.muzzle-dt);
    if(weapon.mode==='semi'){ if(!input.fire) weapon.semiReady=true; }
    if(weapon.mode==='burst'){
      if(!input.fire && burstQ===0) weapon.semiReady=true;
      if(burstQ>0){ burstT-=dt; if(burstT<=0){ fireRay(bdx,bdy); burstQ--; burstT=weapon.burstGap; } }
    }
    const al=Math.hypot(input.aim.x,input.aim.y)||1; if(input.fire) shoot(input.aim.x/al, input.aim.y/al);

    // bullets
    for(let i=bullets.length-1;i>=0;i--){
      const b=bullets[i]; b.age+=dt; b.x+=b.vx*dt; b.y+=b.vy*dt;
      let removed=false;

      // obstacle hits → sparks
      for(const o of world.obstacles){
        if(removed) break;
        if(o.type==='rect'){
          if(aabb(b.x-1,b.y-1,2,2, o.x,o.y,o.w,o.h)){
            spawnSparks(b.x,b.y, Math.atan2(b.vy,b.vx)); cam.shake+=0.1; bullets.splice(i,1); removed=true; break;
          }
        } else {
          const dx=b.x-o.x, dy=b.y-o.y, rr=o.r+2; if(dx*dx+dy*dy<rr*rr){
            spawnSparks(b.x,b.y, Math.atan2(b.vy,b.vx)); cam.shake+=0.1; bullets.splice(i,1); removed=true; break;
          }
        }
      }

      // enemy hits → blood & damage
      for(const e of enemies){
        if(removed||!e.alive) continue;
        if(aabb(b.x-2,b.y-2,4,4, e.x-e.w/2, e.y-e.h/2, e.w, e.h)){
          e.hp=Math.max(0, e.hp-12);
          e.vx+=b.vx*0.02; e.vy+=b.vy*0.02;
          spawnBlood(b.x,b.y, Math.atan2(b.vy,b.vx)); cam.shake+=0.08;
          if(e.hp===0 && e.alive){ e.alive=false; e.fade=0; decals.push({type:'corpse',x:e.x,y:e.y,age:0,life:20,rot:Math.random()*6}); }
          bullets.splice(i,1); removed=true; break;
        }
      }

      // bounds
      if(!removed && (b.x<world.bounds||b.x>world.W-world.bounds||b.y<world.bounds||b.y>world.H-world.bounds)){
        spawnSparks(b.x,b.y, Math.atan2(b.vy,b.vx)); bullets.splice(i,1); removed=true;
      }
      if(!removed && b.age>1.2){ bullets.splice(i,1); }
    }

    // enemies brain / movement / collisions
    for(const e of enemies){
      if(!e.alive){ e.fade+=dt; continue; }

      // awareness: if player within sight or a shot happened recently (approx via cam.shake)
      const dx=player.x-e.x, dy=player.y-e.y, d2=dx*dx+dy*dy, dist=Math.sqrt(d2);
      if(dist<e.sight || cam.shake>0.35){ e.state='chase'; }
      if(e.state==='wander'){
        e.tw-=dt; if(e.tw<=0){ const a=Math.random()*Math.PI*2, m=90+Math.random()*120; e.wx=Math.cos(a)*m; e.wy=Math.sin(a)*m; e.tw=0.8+Math.random()*1.2; }
        e.vx+=(e.wx-e.vx)*Math.min(1,dt*2); e.vy+=(e.wy-e.vy)*Math.min(1,dt*2);
      } else { // chase
        const m=140; const ux=dx/(dist||1), uy=dy/(dist||1); e.vx+=(ux*m-e.vx)*Math.min(1,dt*2.4); e.vy+=(uy*m-e.vy)*Math.min(1,dt*2.4);
      }
      const ef=Math.exp(-11*dt); e.vx*=ef; e.vy*=ef; e.x+=e.vx*dt; e.y+=e.vy*dt;

      // collide world
      e.x=clamp(e.x, world.bounds+e.w/2, world.W-world.bounds-e.w/2);
      e.y=clamp(e.y, world.bounds+e.h/2, world.H-world.bounds-e.h/2);
      for(const o of world.obstacles){
        if(o.type==='rect'){
          if(aabb(e.x-e.w/2, e.y-e.h/2, e.w,e.h, o.x,o.y,o.w,o.h)){
            // simple AABB push-out
            const left=(e.x-(e.w/2))-o.x, right=(o.x+o.w)-(e.x+(e.w/2));
            const top=(e.y-(e.h/2))-o.y, bottom=(o.y+o.h)-(e.y+(e.h/2));
            const minX = Math.min(Math.abs(left), Math.abs(right));
            const minY = Math.min(Math.abs(top), Math.abs(bottom));
            if(minX<minY){
              e.x += (Math.abs(left)<Math.abs(right)? -left : right);
              e.vx = 0;
            } else {
              e.y += (Math.abs(top)<Math.abs(bottom)? -top : bottom);
              e.vy = 0;
            }
          }
        } else {
          const dx=e.x-o.x, dy=e.y-o.y, rr=o.r+Math.max(e.w,e.h)/2;
          if(dx*dx+dy*dy<rr*rr){ const d=Math.hypot(dx,dy)||1, nx=dx/d, ny=dy/d; e.x=o.x+nx*rr; e.y=o.y+ny*rr; const vn=e.vx*nx+e.vy*ny; if(vn<0){ e.vx-=vn*nx; e.vy-=vn*ny; } }
        }
      }
      // collide with player (separate)
      const px=e.x-player.x, py=e.y-player.y, pr=player.r+Math.max(e.w,e.h)/2-6;
      if(px*px+py*py<pr*pr){
        const d=Math.hypot(px,py)||1, nx=px/d, ny=py/d;
        const push= (pr - d);
        e.x += nx*push*0.6; e.y += ny*push*0.6;
        player.x -= nx*push*0.4; player.y -= ny*push*0.4;
      }
    }

    // FX
    for(let i=sparks.length-1;i>=0;i--){ const s=sparks[i]; s.age+=dt; s.vx*=0.98; s.vy=s.vy*0.98+600*dt*0.18; s.x+=s.vx*dt; s.y+=s.vy*dt; if(s.age>s.life) sparks.splice(i,1); }
    for(let i=blood.length-1;i>=0;i--){ const b=blood[i]; b.age+=dt; b.vx*=0.98; b.vy=b.vy*0.98+600*dt*0.22; b.x+=b.vx*dt; b.y+=b.vy*dt; if(b.age>b.life) blood.splice(i,1); }
    for(let i=decals.length-1;i>=0;i--){ const d=decals[i]; d.age+=dt; if(d.age>d.life) decals.splice(i,1); }
  }

  // ---------- Render ----------
  function drawGrid(){
    const vw=c.width/DPR, vh=c.height/DPR;
    const g=ctx.createLinearGradient(0,0,vw,vh); g.addColorStop(0,PAL.bgA); g.addColorStop(1,PAL.bgB);
    ctx.fillStyle=g; ctx.fillRect(0,0,vw,vh);
    const s=world.grid, sx=Math.floor(cam.x/s)*s, sy=Math.floor(cam.y/s)*s;
    for(let y=sy;y<cam.y+vh;y+=s){
      for(let x=sx;x<cam.x+vw;x+=s){
        const gx=Math.floor(x/s), gy=Math.floor(y/s);
        ctx.fillStyle=((gx+gy)&1)?PAL.grid1:PAL.grid2;
        ctx.fillRect(Math.floor(x-cam.x+cam.shx), Math.floor(y-cam.y+cam.shy), s, s);
      }
    }
  }
  function drawObstacles(){
    ctx.lineWidth=1.5;
    for(const o of world.obstacles){
      if(o.type==='rect'){
        ctx.fillStyle='rgba(255,255,255,0.06)'; ctx.strokeStyle='rgba(255,255,255,0.18)';
        ctx.fillRect(o.x-cam.x+cam.shx, o.y-cam.y+cam.shy, o.w, o.h);
        ctx.strokeRect(o.x-cam.x+cam.shx, o.y-cam.y+cam.shy, o.w, o.h);
      } else {
        ctx.fillStyle='rgba(255,255,255,0.06)'; ctx.strokeStyle='rgba(255,255,255,0.18)';
        ctx.beginPath(); ctx.arc(o.x-cam.x+cam.shx, o.y-cam.y+cam.shy, o.r, 0, Math.PI*2); ctx.fill(); ctx.stroke();
      }
    }
  }
  function drawDecals(){
    for(const d of decals){
      ctx.save();
      ctx.translate(d.x-cam.x+cam.shx, d.y-cam.y+cam.shy);
      ctx.rotate(d.rot);
      const k = Math.max(0, 1 - d.age/d.life);
      if(d.type==='blood'){ ctx.fillStyle=`rgba(194,39,39,${0.35*k})`; ctx.beginPath(); ctx.ellipse(0,0,26,18,0,0,Math.PI*2); ctx.fill(); }
      else if(d.type==='debris'){ ctx.fillStyle=`rgba(220,220,220,${0.18*k})`; ctx.fillRect(-8,-3,16,6); }
      else if(d.type==='corpse'){ ctx.fillStyle=`rgba(85,94,110,${0.9*k})`; ctx.fillRect(-18,-14,36,28); }
      ctx.restore();
    }
  }
  function drawEnemies(){
    for(const e of enemies){
      const x=e.x-cam.x+cam.shx, y=e.y-cam.y+cam.shy;
      // corpse doesn't draw here (handled as decal)
      if(!e.alive) continue;

      // body (rounded capsule)
      const w=e.w, h=e.h, r=10;
      ctx.fillStyle=PAL.enemyBody; ctx.strokeStyle=PAL.enemyEdge; ctx.lineWidth=2;
      ctx.beginPath();
      ctx.moveTo(x-w/2+r, y-h/2);
      ctx.arcTo(x+w/2, y-h/2, x+w/2, y+h/2, r);
      ctx.arcTo(x+w/2, y+h/2, x-w/2, y+h/2, r);
      ctx.arcTo(x-w/2, y+h/2, x-w/2, y-h/2, r);
      ctx.arcTo(x-w/2, y-h/2, x+w/2, y-h/2, r);
      ctx.closePath(); ctx.fill(); ctx.stroke();

      // head
      ctx.beginPath(); ctx.arc(x, y-h*0.35, e.r, 0, Math.PI*2); ctx.fillStyle=PAL.enemyHead; ctx.fill();
      // eyes (simple)
      ctx.fillStyle='rgba(0,0,0,0.35)'; ctx.fillRect(x-6, y-h*0.35-3, 12, 4);

      // HP pips
      const pips=Math.ceil((e.hp/e.maxHp)*8), top=y-h/2-10;
      for(let i=0;i<8;i++){ ctx.fillStyle= i<pips ? '#ff6a6a' : 'rgba(255,255,255,0.15)'; ctx.fillRect(x-48+i*12, top, 8, 4); }
    }
  }
  function drawPlayer(){
    const x=player.x-cam.x+cam.shx, y=player.y-cam.y+cam.shy;
    ctx.beginPath(); ctx.arc(x,y,player.r,0,Math.PI*2); ctx.fillStyle=PAL.player; ctx.fill(); ctx.lineWidth=2; ctx.strokeStyle=PAL.playerEdge; ctx.stroke();
    const bl=28;
    ctx.strokeStyle=PAL.barrel; ctx.lineWidth=6; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x+Math.cos(player.ang)*bl, y+Math.sin(player.ang)*bl); ctx.stroke();
    if(weapon.muzzle>0){ const m=10+10*(weapon.muzzle/0.05); ctx.fillStyle=PAL.muzzle; ctx.beginPath(); ctx.arc(x+Math.cos(player.ang)*bl, y+Math.sin(player.ang)*bl, m*0.5, 0,Math.PI*2); ctx.fill(); }
  }
  function drawBullets(){
    for(const b of bullets){
      const tx=b.x-b.vx*b.tail, ty=b.y-b.vy*b.tail;
      const grad=ctx.createLinearGradient(b.x-cam.x+cam.shx, b.y-cam.y+cam.shy, tx-cam.x+cam.shx, ty-cam.y+cam.shy);
      grad.addColorStop(0,PAL.tracerHot); grad.addColorStop(1,PAL.tracerFade);
      ctx.strokeStyle=grad; ctx.lineWidth=2; ctx.lineCap='round';
      ctx.beginPath(); ctx.moveTo(b.x-cam.x+cam.shx, b.y-cam.y+cam.shy); ctx.lineTo(tx-cam.x+cam.shx, ty-cam.y+cam.shy); ctx.stroke();
      ctx.fillStyle='#fff5db'; ctx.beginPath(); ctx.arc(b.x-cam.x+cam.shx, b.y-cam.y+cam.shy, 2.1, 0, Math.PI*2); ctx.fill();
    }
  }
  function drawSparks(){
    for(const s of sparks){
      const r=2*(1-s.age/s.life);
      ctx.fillStyle = s.age < s.life*0.5 ? PAL.sparkHot : PAL.sparkCool;
      ctx.beginPath(); ctx.arc(s.x-cam.x+cam.shx, s.y-cam.y+cam.shy, Math.max(0,r), 0, Math.PI*2); ctx.fill();
    }
    for(const b of blood){
      const r=2.6*(1-b.age/b.life);
      ctx.fillStyle = b.age < b.life*0.5 ? PAL.bloodA : PAL.bloodB;
      ctx.beginPath(); ctx.arc(b.x-cam.x+cam.shx, b.y-cam.y+cam.shy, Math.max(0,r), 0, Math.PI*2); ctx.fill();
    }
  }
  function drawHUD(){
    ctx.fillStyle=PAL.hud; ctx.font='14px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    ctx.fillText(`Mode: ${weapon.mode.toUpperCase()}  (L1)`, 16, 22);
    ctx.fillText(`Sprint: L3`, 16, 40);
  }

  function render(){
    drawGrid();
    drawDecals();
    drawObstacles();
    drawEnemies();
    drawSparks();
    drawBullets();
    drawPlayer();
    drawHUD();
  }

  // ---------- Main ----------
  function frame(now){
    const dt=Math.min(0.033,(now-(frame.t||now))/1000); frame.t=now;
    update(dt); render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();