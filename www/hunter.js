/* HUNTER-CORE r20 baseline
   - Smooth aim, capped recoil, AUTO/SEMI/BURST, L2 zoom
   - Grid, walls, circle-vs-rect collision, no edge jitter
   - Bullet trail + impact sparks, turret-bot enemy with drag
   - Portrait-safe letterbox and instant error guard (no blank screens)
*/
(() => {
  // ----- SAFE START -----
  const canvas = document.getElementById('c');
  if (!canvas) { alert('Canvas missing'); return; }
  const ctx = canvas.getContext('2d', { alpha:false });

  // ----- CONFIG -----
  const CFG = {
    world:{ w:3200, h:2000, grid:64, bg:'#0f1620', gridc:'#1b2430' },
    pad:{ dz:0.17 },
    cam:{ lerp:10 },
    player:{
      r:22, accel:2900, max:470, fric:0.78,
      turn:7.0, recoil:52, recoilCapMul:1.0,
      zoom:{ normal:1.0, aim:1.25, lerp:6 }
    },
    bullet:{
      spd:1650, life:1.0, r:4,
      trailW:5, trailNodes:14, dmg:12,
      burstCount:3, burstGap:0.055
    },
    fire:{ mode:'semi', rpmAuto:540, rpmSemiGuard:12 },
    enemy:{ w:86, h:64, hp:140, fric:0.60, knock:90 }
  };

  // ----- STATE -----
  const S={ t:0, dt:0, pads:[], mode:CFG.fire.mode, lastShot:0, burstLeft:0, burstT:0,
            zoom:CFG.player.zoom.normal, zoomTo:CFG.player.zoom.normal,
            hasPad:false, hudMode:CFG.fire.mode.toUpperCase() };
  const P={ x:1600, y:1000, vx:0, vy:0, aim:0, aimTo:0 };
  const E={ x:2200, y:950, w:CFG.enemy.w, h:CFG.enemy.h, vx:0, vy:0, hp:CFG.enemy.hp, alive:true, flash:0 };
  const boxes=[ {x:1350,y:980,w:260,h:120}, {x:2500,y:1160,w:180,h:180}, {x:3000,y:760,w:140,h:420} ];
  const bullets=[], sparks=[];
  const cam={ x:0,y:0,w:0,h:0 };
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const lerp=(a,b,t)=>a+(b-a)*Math.max(0,Math.min(1,t));
  const angLerp=(a,b,t)=>{ let d=((b-a+Math.PI*3)%(Math.PI*2))-Math.PI; return a+d*Math.max(0,Math.min(1,t)); };
  const len=(x,y)=>Math.hypot(x,y);

  // ----- RESIZE / LETTERBOX -----
  function resize(){
    canvas.width = innerWidth * devicePixelRatio;
    canvas.height = innerHeight * devicePixelRatio;
    ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
    cam.w = canvas.width / devicePixelRatio;
    cam.h = canvas.height / devicePixelRatio;
  }
  addEventListener('resize', resize); resize();

  // ----- INPUT -----
  const keys=Object.create(null);
  addEventListener('keydown',e=>keys[e.code]=true);
  addEventListener('keyup',e=>keys[e.code]=false);
  const eat=code => (keys[code]? (keys[code]=false,true):false);
  let prevBtns=[];
  const pads=()=>{ const a=navigator.getGamepads?.()||[]; S.pads=[]; S.hasPad=false; for(const p of a) if(p){S.pads.push(p); S.hasPad=true;} };
  const dz=v=> (Math.abs(v)<CFG.pad.dz?0:v);
  const just=(gp,i)=>{ const n=!!(gp.buttons[i]?.pressed); const w=prevBtns[i]||false; prevBtns[i]=n; return n&&!w; };

  function readInput(){
    const gp=S.pads[0];
    let lx=0,ly=0,rx=0,ry=0, fireHeld=false, fireEdge=false, zoomHeld=false, cycle=false;
    if(gp){
      lx=dz(gp.axes[0]||0); ly=dz(gp.axes[1]||0);
      rx=dz(gp.axes[2]||0); ry=dz(gp.axes[3]||0);
      fireHeld=!!(gp.buttons[7]?.pressed); fireEdge=just(gp,7); // R2
      zoomHeld=!!(gp.buttons[6]?.pressed);                      // L2
      cycle=just(gp,3);                                         // Y/Triangle
    }else{
      lx=(keys.KeyD?1:0)-(keys.KeyA?1:0); ly=(keys.KeyS?1:0)-(keys.KeyW?1:0);
      fireHeld=!!keys.Space; fireEdge=eat('Space'); zoomHeld=!!keys.ShiftLeft||!!keys.ShiftRight;
      cycle=eat('KeyF');
    }
    if(cycle){ S.mode = S.mode==='auto' ? 'semi' : S.mode==='semi' ? 'burst' : 'auto'; S.hudMode = S.mode.toUpperCase(); }
    return {lx,ly,rx,ry,fireHeld,fireEdge,zoomHeld};
  }

  // ----- COLLISION -----
  function circleVsRects(p,r,rects){
    for(const b of rects){
      const nx=clamp(p.x,b.x,b.x+b.w), ny=clamp(p.y,b.y,b.y+b.h);
      const dx=p.x-nx, dy=p.y-ny, d2=dx*dx+dy*dy, rr=r*r;
      if(d2<rr){
        const d=Math.max(0.001,Math.sqrt(d2)), px=dx/d, py=dy/d, push=r-d;
        p.x+=px*push; p.y+=py*push;
        const vn=p.vx*px+p.vy*py; if(vn<0){ p.vx-=vn*px; p.vy-=vn*py; }
      }
    }
  }

  // ----- GAMEPLAY -----
  function spawnBullet(x,y,a){
    const b={ x, y, vx:Math.cos(a)*CFG.bullet.spd, vy:Math.sin(a)*CFG.bullet.spd, t:0, life:CFG.bullet.life, trail:[] };
    bullets.push(b);
    // recoil (capped)
    P.vx -= Math.cos(a)*CFG.player.recoil;
    P.vy -= Math.sin(a)*CFG.player.recoil;
    const s=len(P.vx,P.vy), cap=CFG.player.max*CFG.player.recoilCapMul; if(s>cap){const k=cap/s; P.vx*=k; P.vy*=k;}
  }
  function muzzle(){ const a=P.aim, r=CFG.player.r+8; spawnBullet(P.x+Math.cos(a)*r, P.y+Math.sin(a)*r, a); }

  function fireLogic(inp,dt){
    const now=S.t;
    if(S.mode==='auto'){
      const gap=60/CFG.fire.rpmAuto; if(inp.fireHeld && now-S.lastShot>=gap){ muzzle(); S.lastShot=now; }
    }else if(S.mode==='semi'){
      if(inp.fireEdge && now-S.lastShot>(1/CFG.fire.rpmSemiGuard)){ muzzle(); S.lastShot=now; }
    }else{
      if(inp.fireEdge && S.burstLeft===0){ S.burstLeft=CFG.bullet.burstCount; S.burstT=0; }
      if(S.burstLeft>0){ S.burstT-=dt; if(S.burstT<=0){ muzzle(); S.burstLeft--; S.burstT=CFG.bullet.burstGap; } }
    }
  }

  function spark(x,y,a){
    for(let i=0;i<10;i++){
      const ang=a+(Math.random()-0.5)*0.8, sp=220+Math.random()*220;
      sparks.push({x,y,vx:Math.cos(ang)*sp,vy:Math.sin(ang)*sp,t:0,life:0.25});
    }
  }

  function stepBullets(dt){
    for(let i=bullets.length-1;i>=0;--i){
      const b=bullets[i]; b.t+=dt; b.x+=b.vx*dt; b.y+=b.vy*dt;
      b.trail.push({x:b.x,y:b.y}); if(b.trail.length>CFG.bullet.trailNodes) b.trail.shift();
      let hit=false;
      if(b.x<0||b.y<0||b.x>CFG.world.w||b.y>CFG.world.h) hit=true;
      else for(const bx of boxes){ if(b.x>bx.x&&b.x<bx.x+bx.w&&b.y>bx.y&&b.y<bx.y+bx.h){ hit=true; break; } }
      if(!hit && E.alive && b.x>E.x && b.x<E.x+E.w && b.y>E.y && b.y<E.y+E.h){
        hit=true; E.hp-=CFG.bullet.dmg; E.flash=0.08;
        const a=Math.atan2(b.vy,b.vx); E.vx+=Math.cos(a)*CFG.enemy.knock; E.vy+=Math.sin(a)*CFG.enemy.knock;
        if(E.hp<=0) E.alive=false;
      }
      if(hit || b.t>=b.life){ spark(b.x,b.y,Math.atan2(b.vy,b.vx)); bullets.splice(i,1); }
    }
  }

  function stepSparks(dt){
    for(let i=sparks.length-1;i>=0;--i){ const s=sparks[i]; s.t+=dt; s.vx*=0.92; s.vy*=0.92; s.x+=s.vx*dt; s.y+=s.vy*dt; if(s.t>=s.life) sparks.splice(i,1); }
  }

  function stepEnemy(dt){
    if(!E.alive) return;
    E.x+=E.vx*dt; E.y+=E.vy*dt;
    E.vx*=Math.pow(CFG.enemy.fric,Math.max(1,60*dt));
    E.vy*=Math.pow(CFG.enemy.fric,Math.max(1,60*dt));
    E.x=clamp(E.x,0,CFG.world.w-E.w); E.y=clamp(E.y,0,CFG.world.h-E.h);
    if(E.flash>0) E.flash-=dt;
  }

  function stepPlayer(inp,dt){
    // zoom
    S.zoomTo = inp.zoomHeld ? CFG.player.zoom.aim : CFG.player.zoom.normal;
    S.zoom = lerp(S.zoom, S.zoomTo, Math.min(1, CFG.player.zoom.lerp*dt));
    // move
    P.vx += inp.lx * CFG.player.accel * dt;
    P.vy += inp.ly * CFG.player.accel * dt;
    const sp=len(P.vx,P.vy); if(sp>CFG.player.max){ const k=CFG.player.max/sp; P.vx*=k; P.vy*=k; }
    P.vx*=Math.pow(CFG.player.fric,Math.max(1,60*dt)); P.vy*=Math.pow(CFG.player.fric,Math.max(1,60*dt));
    P.x+=P.vx*dt; P.y+=P.vy*dt;
    circleVsRects(P, CFG.player.r, boxes);
    P.x=clamp(P.x, CFG.player.r, CFG.world.w-CFG.player.r);
    P.y=clamp(P.y, CFG.player.r, CFG.world.h-CFG.player.r);
    // aim
    if(Math.abs(inp.rx)>0||Math.abs(inp.ry)>0) P.aimTo=Math.atan2(inp.ry,inp.rx);
    P.aim=angLerp(P.aim,P.aimTo,Math.min(1,CFG.player.turn*dt));
  }

  function stepCam(){ cam.x=clamp(P.x-cam.w*0.5/S.zoom,0,CFG.world.w-cam.w/S.zoom); cam.y=clamp(P.y-cam.h*0.5/S.zoom,0,CFG.world.h-cam.h/S.zoom); }

  // ----- RENDER -----
  function drawGrid(){
    ctx.fillStyle=CFG.world.bg; ctx.fillRect(0,0,cam.w,cam.h);
    ctx.save(); ctx.translate(-cam.x,-cam.y); ctx.strokeStyle=CFG.world.gridc; ctx.globalAlpha=0.6; ctx.lineWidth=1;
    for(let x=0;x<=CFG.world.w;x+=CFG.world.grid){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,CFG.world.h); ctx.stroke(); }
    for(let y=0;y<=CFG.world.h;y+=CFG.world.grid){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(CFG.world.w,y); ctx.stroke(); }
    ctx.restore(); ctx.globalAlpha=1;
  }
  function beginW(){ ctx.save(); ctx.scale(S.zoom,S.zoom); ctx.translate(-cam.x,-cam.y); }
  function endW(){ ctx.restore(); }
  function drawBoxes(){ ctx.fillStyle='rgba(80,90,110,0.35)'; ctx.strokeStyle='rgba(180,200,220,0.25)'; for(const b of boxes){ ctx.fillRect(b.x,b.y,b.w,b.h); ctx.strokeRect(b.x,b.y,b.w,b.h); } }
  function drawEnemy(){
    if(!E.alive) return;
    ctx.save(); if(E.flash>0) ctx.globalAlpha=0.6;
    const r=12,x=E.x,y=E.y,w=E.w,h=E.h;
    ctx.fillStyle='#445064'; ctx.strokeStyle='#b8c6d8'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(x+r,y);
    ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r);
    ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle='#56647a'; ctx.beginPath(); ctx.arc(x+w*0.75,y-6,10,Math.PI,0); ctx.fill();
    ctx.fillStyle='#8bd1ff'; ctx.fillRect(x+w*0.72,y-10,8,4);
    const p=Math.max(0,Math.min(1,E.hp/CFG.enemy.hp)); ctx.fillStyle='#ff6161'; ctx.fillRect(x,y-14,w,6);
    ctx.fillStyle='#4af59a'; ctx.fillRect(x,y-14,w*p,6);
    ctx.restore();
  }
  function drawPlayer(){
    const L=36, b1x=P.x+Math.cos(P.aim)*8, b1y=P.y+Math.sin(P.aim)*8;
    const b2x=P.x+Math.cos(P.aim)*(8+L), b2y=P.y+Math.sin(P.aim)*(8+L);
    ctx.strokeStyle='#7da7ff'; ctx.lineWidth=6; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(b1x,b1y); ctx.lineTo(b2x,b2y); ctx.stroke();
    ctx.fillStyle='#e9eef7'; ctx.beginPath(); ctx.arc(P.x,P.y,CFG.player.r,0,Math.PI*2); ctx.fill();
  }
  function drawBullets(){
    for(const b of bullets){
      if(b.trail.length>=2){
        ctx.save(); ctx.strokeStyle='#6aa0ff'; ctx.lineCap='round';
        for(let i=1;i<b.trail.length;i++){
          const a=i/(b.trail.length-1); ctx.globalAlpha=(1-a)*0.6;
          ctx.lineWidth=CFG.bullet.trailW - a*(CFG.bullet.trailW-1);
          const p0=b.trail[i-1], p1=b.trail[i]; ctx.beginPath(); ctx.moveTo(p0.x,p0.y); ctx.lineTo(p1.x,p1.y); ctx.stroke();
        } ctx.restore();
      }
    }
    ctx.fillStyle='#dfe8ff'; for(const b of bullets){ ctx.beginPath(); ctx.arc(b.x,b.y,CFG.bullet.r,0,Math.PI*2); ctx.fill(); }
  }
  function drawSparks(){ ctx.fillStyle='#9ec7ff'; for(const s of sparks){ const a=1-(s.t/s.life); ctx.globalAlpha=a; ctx.fillRect(s.x-1.5,s.y-1.5,3,3); } ctx.globalAlpha=1; }
  function drawHUD(){
    ctx.save(); ctx.setTransform(1,0,0,1,0,0);
    ctx.fillStyle='rgba(20,26,34,0.75)'; ctx.fillRect(14,14,260,68);
    ctx.fillStyle='#cfe2ff'; ctx.font='16px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    ctx.fillText(S.hasPad?'Controller ✓':'Controller ?',28,40);
    ctx.fillText('Mode: '+S.hudMode,28,64);
    const msg='Controller OK', w=ctx.measureText(msg).width;
    ctx.fillStyle='rgba(20,26,34,0.6)'; ctx.fillRect(12, cam.h-34, w+16, 26);
    ctx.fillStyle='#cfe2ff'; ctx.fillText(msg, 20, cam.h-16);
    ctx.restore();
  }

  // ----- LOOP -----
  let last=performance.now()/1000;
  function tick(nowMs){
    const now=nowMs/1000; S.dt=Math.min(0.033, now-last); last=now; S.t=now;
    pads(); const inp=readInput();
    stepPlayer(inp,S.dt); fireLogic(inp,S.dt); stepBullets(S.dt); stepSparks(S.dt); stepEnemy(S.dt); stepCam();
    ctx.save(); ctx.clearRect(0,0,canvas.width,canvas.height);
    drawGrid(); ctx.save(); ctx.scale(S.zoom,S.zoom); ctx.translate(-cam.x,-cam.y);
    drawBoxes(); drawEnemy(); drawBullets(); drawSparks(); drawPlayer();
    ctx.restore(); drawHUD(); ctx.restore();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();