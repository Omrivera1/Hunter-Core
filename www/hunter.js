/* HUNTER-CORE r20 -- JW shooting + waves + spitter + fixes
   - SEMI & SHOTGUN are one-shot-per-trigger
   - AUTO continuous; BURST gated, no faster than AUTO
   - Tracer lines + muzzle flash; obstacle-only sparks; enemy blood ok
   - Collide & slide for everyone; no clipping
   - Static floor (no drifting)
   - Obstacles: a few shapes to navigate
   - Enemy mix: runners + spitters (short-range poison bolts)
   - Waves: enemy cap grows per wave + fade transition
*/
(() => {
  // ---------- Canvas / Camera ----------
  const c = document.getElementById('c');
  const g = c.getContext('2d', { alpha:false });
  const DPR = Math.max(1, Math.min(2, devicePixelRatio||1));
  let W=0,H=0;
  function resize(){
    W=innerWidth; H=innerHeight;
    c.width=W*DPR; c.height=H*DPR;
    c.style.width=W+'px'; c.style.height=H+'px';
    g.setTransform(DPR,0,0,DPR,0,0);
  }
  addEventListener('resize',resize); resize();

  const cam = {x:900,y:520, shake:0,
    begin(){ g.save(); if(this.shake>0){ const s=this.shake; this.shake*=0.90;
      g.translate((Math.random()*2-1)*6*s,(Math.random()*2-1)*6*s); }
      g.translate(Math.floor(W*0.5-this.x), Math.floor(H*0.5-this.y));
    },
    end(){ g.restore(); },
    bump(a){ this.shake=Math.min(0.5,this.shake+a); }
  };

  // ---------- Input ----------
  const input = {lx:0,ly:0,rx:0,ry:0,L1:false,L3:false,R2:false,A:false,_R2Prev:false,_L1Prev:false};
  const keys={};
  addEventListener('keydown',e=>keys[e.code]=true);
  addEventListener('keyup',e=>keys[e.code]=false);

  const mouse={x:0,y:0,down:false};
  c.addEventListener('mousemove',e=>{
    const r=c.getBoundingClientRect();
    mouse.x = cam.x - W*0.5 + (e.clientX-r.left);
    mouse.y = cam.y - H*0.5 + (e.clientY-r.top);
  });
  c.addEventListener('mousedown',()=>mouse.down=true);
  addEventListener('mouseup',()=>mouse.down=false);

  function pollInput(){
    const pads = navigator.getGamepads?.()||[];
    const p = pads.find(p=>p&&p.connected);
    if (p){
      input.lx=p.axes[0]||0; input.ly=p.axes[1]||0;
      input.rx=p.axes[2]||0; input.ry=p.axes[3]||0;
      input.L1=!!p.buttons[4]?.pressed;
      input.L3=!!p.buttons[10]?.pressed;
      input.R2=!!p.buttons[7]?.pressed;
      input.A =!!p.buttons[0]?.pressed;  // Cross/A
    } else {
      input.lx=(keys.KeyD||keys.ArrowRight?1:0)-(keys.KeyA||keys.ArrowLeft?1:0);
      input.ly=(keys.KeyS||keys.ArrowDown?1:0)-(keys.KeyW||keys.ArrowUp?1:0);
      const dx=mouse.x-player.x, dy=mouse.y-player.y, L=Math.hypot(dx,dy)||1;
      input.rx=dx/L; input.ry=dy/L;
      input.L1=!!keys.KeyQ; input.L3=!!(keys.ShiftLeft||keys.ShiftRight);
      input.R2=mouse.down||!!keys.Space;
      input.A =!!keys.Enter;
    }
  }

  // ---------- World ----------
  const world = { grid:64, solids:[] };
  // helper
  const R=(x,y,w,h)=>({x,y,w,h});
  function buildMap(){
    world.solids = [
      R( 520, 320, 520, 70),
      R( 980, 320, 140, 70),
      R(1340, 530, 120, 260),
      R( 820, 540, 120, 120),
      R( 630, 520, 300, 120),
      // "lane" frame: outer solid ring with a pass-through middle
      R(1150, 250, 280, 40), R(1150, 430, 280, 40),
      R(1010, 340, 40, 220), R(1290, 340, 40, 220),
    ];
  }

  // ---------- Player ----------
  const player = {x:900,y:520,vx:0,vy:0,r:18,
    accel:0.9,fric:0.85, base:2.9, sprint:4.5,
    hp:120,maxhp:120, aim:0, mode:0, // 0=AUTO 1=BURST 2=SEMI 3=SHOTGUN
    canSemi:true
  };
  const MODES=['AUTO','BURST','SEMI','SHOTGUN'];

  // ---------- Enemies / Waves ----------
  const enemies=[], bullets=[], proj=[], parts=[];
  const ENEMY = {
    base:1.6, notice:2.2, frenzy:3.1, frenzyFrac:0.33,
    maxAliveBase:8
  };
  const WAVES={idx:1, aliveCap(){return ENEMY.maxAliveBase + (this.idx-1)*2;},
    state:'fadeIn', alpha:1, timer:90};

  function makeEnemy(){
    const angle=Math.random()*Math.PI*2, dist= 900;
    const type = Math.random()<0.25 ? 'spitter' : 'runner';
    const hp = type==='spitter'? 95: 90;
    return {x:player.x+Math.cos(angle)*dist, y:player.y+Math.sin(angle)*dist,
      vx:0,vy:0,r:16,hp,maxhp:hp,type,dead:false,fade:0,lastDir:0, spitCd:0,pulse:0};
  }

  function enemySpeed(e){
    if (e.hp/e.maxhp<=ENEMY.frenzyFrac) return ENEMY.frenzy;
    const dx=e.x-player.x, dy=e.y-player.y;
    return (dx*dx+dy*dy<700*700) ? ENEMY.notice : ENEMY.base;
  }

  // ---------- FX ----------
  const FX={
    tracer:'#e8e8ff',
    tracerHot:'#ffcf7a',
    muzzle:['#ffd27a','#ffab49','#fff2c4'],
    bloodStops:['#9a0f12','#c2171d','#e61e24'],
    spark:'#c8d4ff'
  };
  function addMuzzle(x,y,dir){
    for(let i=0;i<8;i++){
      const a=dir+rand(-0.35,0.35), s=rand(2.2,5.5);
      parts.push({x,y, vx:Math.cos(a)*s, vy:Math.sin(a)*s, t:rand(120,220),
        r:rand(2,4), col: pick(FX.muzzle), type:'muzzle', drag:0.92});
    }
  }
  function blood(x,y,dir,count,lifeMin,lifeMax){
    for(let i=0;i<count;i++){
      const a=dir+rand(-0.6,0.6), s=rand(2.8,6.5);
      parts.push({x,y, vx:Math.cos(a)*s, vy:Math.sin(a)*s, t:rand(lifeMin,lifeMax),
        r:rand(2,5), col:pick(FX.bloodStops), type:'blood', drag:0.985, g:0.07});
    }
  }
  function sparks(x,y,nx,ny){
    const base=Math.atan2(ny,nx)+Math.PI;
    for(let i=0;i<12;i++){
      const a=base+rand(-Math.PI/6,Math.PI/6), s=rand(3,7);
      parts.push({x,y, vx:Math.cos(a)*s, vy:Math.sin(a)*s, t:rand(110,200),
        r:rand(1.5,2.6), col:FX.spark, type:'spark', drag:0.94});
    }
  }

  // ---------- Helpers ----------
  const rand=(a,b)=>a+Math.random()*(b-a);
  const pick=a=>a[(Math.random()*a.length)|0];

  // collision
  function circleRect(circ, r){
    const rx=r.x-r.w*0.5, ry=r.y-r.h*0.5;
    const cx=Math.max(rx,Math.min(circ.x,rx+r.w));
    const cy=Math.max(ry,Math.min(circ.y,ry+r.h));
    const dx=circ.x-cx, dy=circ.y-cy;
    const d2=dx*dx+dy*dy, rr=circ.r*circ.r;
    if (d2<rr){
      const d=Math.max(0.0001,Math.sqrt(d2));
      const nx=dx/d, ny=dy/d, push= circ.r-d;
      return {hit:true,nx,ny,push,cx,cy};
    }
    return {hit:false};
  }
  function slide(m){
    m.x+=m.vx; m.y+=m.vy;
    for(let k=0;k<2;k++){
      let any=false;
      for(const s of world.solids){
        const res=circleRect({x:m.x,y:m.y,r:m.r},s);
        if(res.hit){
          m.x+=res.nx*res.push; m.y+=res.ny*res.push;
          const vn=m.vx*res.nx+m.vy*res.ny; if(vn>0){ m.vx-=vn*res.nx; m.vy-=vn*res.ny; }
          any=true;
        }
      }
      if(!any) break;
    }
  }

  // ---------- Bullets / Poison ----------
  function fireBullet(dir, speed, dmg, spread=0, life=520, radius=3){
    const a=dir+rand(-spread,spread);
    bullets.push({
      x:player.x+Math.cos(player.aim)*player.r*1.2,
      y:player.y+Math.sin(player.aim)*player.r*1.2,
      vx:Math.cos(a)*speed, vy:Math.sin(a)*speed,
      ttl:life, r:radius, dmg, dir:a,
      trail: [] // store last points for hot tracer
    });
    addMuzzle(player.x,player.y,dir);
  }

  function fireShotgun(){
    const pellets=7;
    for(let i=0;i<pellets;i++) fireBullet(player.aim,13,12,0.22,300,3);
    cam.bump(0.22);
  }

  function spitAt(e){
    const dx=player.x-e.x, dy=player.y-e.y, a=Math.atan2(dy,dx);
    proj.push({x:e.x, y:e.y, vx:Math.cos(a)*5.2, vy:Math.sin(a)*5.2, r:5, ttl:220, col:'#6ef590'});
  }

  // ---------- Shooting controller ----------
  const FIRE={
    AUTO:{rate:7,speed:11,dmg:20,spread:0.02,life:380},
    BURST:{rate:8, size:3, gap:3, speed:11,dmg:16,spread:0.03,life:380},
    SEMI:{rate:10,speed:12,dmg:28,spread:0.01,life:430},
    SHOTGUN:{rate:16}
  };
  let burstLeft=0, burstTimer=0, fireCd=0;

  function shootLogic(dt){
    // toggle mode (debounced)
    if (!input._L1Prev && input.L1) player.mode=(player.mode+1)%MODES.length;
    input._L1Prev=input.L1;

    fireCd-=dt; if(fireCd<0) fireCd=0;

    const pressed = input.R2 && !input._R2Prev; // rising edge
    const held    = input.R2;

    switch(player.mode){
      case 0: // AUTO
        if (held && fireCd===0){
          const P=FIRE.AUTO;
          fireBullet(player.aim,P.speed,P.dmg,P.spread,P.life);
          cam.bump(0.08);
          fireCd=P.rate;
        }
      break;
      case 1: // BURST (edge to start burst; internal cadence respects rate)
        if (pressed && burstLeft<=0){ burstLeft=FIRE.BURST.size; burstTimer=0; }
        if (burstLeft>0 && fireCd===0){
          if (burstTimer<=0){
            const P=FIRE.BURST;
            fireBullet(player.aim,P.speed,P.dmg,P.spread,P.life);
            cam.bump(0.07);
            burstLeft--; burstTimer=P.gap; fireCd=FIRE.BURST.rate;
          } else burstTimer-=dt;
        }
      break;
      case 2: // SEMI (edge only)
        if (pressed && fireCd===0){
          const P=FIRE.SEMI;
          fireBullet(player.aim,P.speed,P.dmg,P.spread,P.life);
          cam.bump(0.09);
          fireCd=P.rate;
        }
      break;
      case 3: // SHOTGUN (edge only)
        if (pressed && fireCd===0){ fireShotgun(); fireCd=FIRE.SHOTGUN.rate; }
      break;
    }
    input._R2Prev=input.R2;
  }

  // ---------- Game / Menu ----------
  let state='menu', menuIdx=0, menuCd=0;

  function startGame(){
    state='game';
    resetLevel(true);
  }

  function resetLevel(first=false){
    if(first){ buildMap(); player.x=900; player.y=520; player.vx=player.vy=0; }
    bullets.length=0; proj.length=0; parts.length=0; enemies.length=0;
    player.hp=player.maxhp; player.mode=0; input._R2Prev=false;
    WAVES.state='fadeIn'; WAVES.alpha=1; WAVES.timer=60; // fade in at start/wave
  }

  // ---------- Update ----------
  let lt=0;
  function tick(ts){
    requestAnimationFrame(tick);
    const now=ts|0; const dt=Math.min(20, now-lt||16); lt=now;

    pollInput();

    if(state==='menu'){
      // move cursor
      if(menuCd>0) menuCd-=dt;
      if(menuCd<=0){
        if(input.ly<-0.4){ menuIdx=(menuIdx+1)%2; menuCd=150; }
        if(input.ly> 0.4){ menuIdx=(menuIdx+1)%2; menuCd=150; }
      }
      if(input.A){ if(menuIdx===0) startGame(); else alert('Move: LS • Aim: RS • Fire: R2 • Sprint: L3 • Switch Mode: L1'); }
      drawMenu();
      return;
    }

    update(dt);
    draw();
  }

  function update(dt){
    // waves
    if (WAVES.state==='fadeIn'){ WAVES.alpha-=0.05; if(WAVES.alpha<=0){ WAVES.alpha=0; WAVES.state='play'; } }

    // aim smoothing
    if (Math.hypot(input.rx,input.ry)>0.2){
      const want=Math.atan2(input.ry,input.rx);
      let d=((want-player.aim+Math.PI*3)%(Math.PI*2))-Math.PI;
      player.aim+=d*0.25;
    }

    // move
    const spd = input.L3?player.sprint:player.base;
    player.vx = player.vx*player.fric + input.lx*player.accel;
    player.vy = player.vy*player.fric + input.ly*player.accel;
    const m = Math.hypot(player.vx,player.vy);
    const cap = spd; if(m>cap){ player.vx=player.vx/m*cap; player.vy=player.vy/m*cap; }
    slide(player);

    cam.x=player.x; cam.y=player.y;

    shootLogic(dt);

    // bullets
    for(let i=bullets.length-1;i>=0;i--){
      const b=bullets[i];
      // trail
      b.trail.push({x:b.x,y:b.y,ttl:80});
      if(b.trail.length>12) b.trail.shift();
      b.x+=b.vx; b.y+=b.vy; b.ttl--;
      if (bulletHitSolid(b) || bulletHitEnemy(b) || b.ttl<=0){ bullets.splice(i,1); }
    }

    // poison
    for(let i=proj.length-1;i>=0;i--){
      const p=proj[i]; p.x+=p.vx; p.y+=p.vy; p.ttl--;
      // collide solid
      for(const s of world.solids){
        if(circleRect({x:p.x,y:p.y,r:p.r},s).hit){ proj.splice(i,1); i--; break; }
      }
      // hit player
      const d2=(p.x-player.x)**2+(p.y-player.y)**2, rr=(p.r+player.r)*(p.r+player.r);
      if(d2<rr){ player.hp=Math.max(0,player.hp-12); cam.bump(0.08); proj.splice(i,1); }
      else if(p.ttl<=0) proj.splice(i,1);
    }

    // enemies
    const need = WAVES.aliveCap() - enemies.filter(e=>!e.dead && !e.remove).length;
    for(let i=0;i<need;i++) enemies.push(makeEnemy());

    for(let i=enemies.length-1;i>=0;i--){
      const e=enemies[i];
      if(e.remove){ enemies.splice(i,1); continue; }
      if(e.dead){ e.fade-=0.05; if(e.fade<=0) e.remove=true; continue; }

      const a=Math.atan2(player.y-e.y, player.x-e.x);
      const sp=enemySpeed(e); e.vx=Math.cos(a)*sp; e.vy=Math.sin(a)*sp;
      slide(e);

      // touch pulses
      const rr=(e.r+player.r)*(e.r+player.r);
      if((e.x-player.x)**2+(e.y-player.y)**2<rr){
        if(e.pulse<=0){ player.hp=Math.max(0,player.hp-10); cam.bump(0.1); e.pulse=280; } else e.pulse-=dt*16;
      } else e.pulse=0;

      // spitter AI (short range)
      if(e.type==='spitter'){
        const d = Math.hypot(player.x-e.x, player.y-e.y);
        e.spitCd-=dt;
        if(d<180 && e.spitCd<=0){ spitAt(e); e.spitCd=600; }
      }
    }

    // particles
    for(let i=parts.length-1;i>=0;i--){
      const p=parts[i]; p.vx*=p.drag||1; p.vy*=p.drag||1; p.vy+=(p.g||0);
      p.x+=p.vx; p.y+=p.vy; p.t--; if(p.t<=0) parts.splice(i,1);
    }

    // wave progress / game over
    if(player.hp<=0){ state='menu'; resetLevel(true); return; }
    if (enemies.filter(e=>!e.dead && !e.remove).length===0){
      WAVES.idx++; WAVES.state='fadeIn'; WAVES.alpha=1; WAVES.timer=60;
    }
  }

  // collisions
  function bulletHitSolid(b){
    for(const s of world.solids){
      const res=circleRect({x:b.x,y:b.y,r:b.r},s);
      if(res.hit){ sparks(res.cx,res.cy,res.nx,res.ny); return true; }
    }
    return false;
  }
  function bulletHitEnemy(b){
    for(const e of enemies){
      if(e.dead) continue;
      const d2=(e.x-b.x)**2+(e.y-b.y)**2, rr=(e.r+b.r)*(e.r+b.r);
      if(d2<=rr){
        e.hp-=b.dmg; e.lastDir=b.dir;
        blood(b.x,b.y,b.dir, 12, 200, 420);
        cam.bump(0.08);
        if(e.hp<=0){ e.dead=true; e.fade=1; blood(e.x,e.y,e.lastDir||b.dir, 70, 360, 720); cam.bump(0.25); }
        return true;
      }
    }
    return false;
  }

  // ---------- Draw ----------
  function drawFloor(){
    // Static checker anchored to world origin; no shimmer
    const s=world.grid;
    // figure visible bounds
    const x0 = Math.floor((cam.x-W*0.5)/s)-1;
    const y0 = Math.floor((cam.y-H*0.5)/s)-1;
    const nx = Math.ceil(W/s)+3, ny=Math.ceil(H/s)+3;
    for(let iy=0; iy<ny; iy++){
      for(let ix=0; ix<nx; ix++){
        const wx=(x0+ix)*s, wy=(y0+iy)*s;
        const i=((x0+ix)+(y0+iy))&1;
        g.fillStyle= i? '#0f1620' : '#121b26';
        g.fillRect(wx,wy,s,s);
      }
    }
  }

  function drawWorld(){
    drawFloor();
    // solids
    for(const s of world.solids){
      g.fillStyle='rgba(180,195,220,0.08)';
      g.strokeStyle='rgba(190,205,235,0.35)';
      g.lineWidth=2;
      g.beginPath(); g.rect(s.x-s.w*0.5, s.y-s.h*0.5, s.w, s.h); g.fill(); g.stroke();
    }
    // bullets (tracers first)
    for(const b of bullets){
      if(b.trail.length>1){
        const last=b.trail[b.trail.length-1];
        g.lineWidth=2; g.lineCap='round';
        const grad=g.createLinearGradient(last.x,last.y,b.x,b.y);
        grad.addColorStop(0,FX.tracerHot);
        grad.addColorStop(1,FX.tracer);
        g.strokeStyle=grad;
        g.beginPath(); g.moveTo(last.x,last.y); g.lineTo(b.x,b.y); g.stroke();
      }
      g.fillStyle='#cbd6ff'; g.beginPath(); g.arc(b.x,b.y,b.r,0,Math.PI*2); g.fill();
    }
    // poison
    for(const p of proj){
      g.fillStyle=p.col; g.beginPath(); g.arc(p.x,p.y,p.r,0,Math.PI*2); g.fill();
    }
    // enemies
    for(const e of enemies){
      if(e.dead){ g.globalAlpha=Math.max(0,e.fade); g.fillStyle='#2a0b10';
        g.beginPath(); g.arc(e.x,e.y,e.r*0.9,0,Math.PI*2); g.fill(); g.globalAlpha=1; continue; }
      // silhouette
      g.fillStyle= (e.type==='spitter') ? '#c5f1d1' : '#b9deff';
      g.strokeStyle= (e.type==='spitter') ? '#86d09f' : '#92c2ff';
      g.lineWidth=3;
      roundRect(e.x-18, e.y-18, 36, 36, 10, true, true);
      g.beginPath(); g.arc(e.x, e.y-26, 12, 0, Math.PI*2); g.fill(); g.stroke();
      // hp bar
      const frac=Math.max(0,e.hp/e.maxhp);
      g.strokeStyle='#e37a7a'; g.lineWidth=4;
      g.beginPath(); g.moveTo(e.x-16, e.y-36); g.lineTo(e.x-16+32*frac, e.y-36); g.stroke();
    }
    // particles
    for(const p of parts){
      if(p.type==='blood'){ g.globalAlpha=Math.max(0,p.t/400); g.fillStyle=p.col;
        g.beginPath(); g.arc(p.x,p.y,p.r,0,Math.PI*2); g.fill(); g.globalAlpha=1; }
      else if(p.type==='muzzle'){ g.globalAlpha=Math.max(0,p.t/220); g.fillStyle=p.col;
        g.fillRect(p.x-1,p.y-1,p.r*1.6,p.r*1.6); g.globalAlpha=1; }
      else { g.globalAlpha=Math.max(0,p.t/200); g.fillStyle=p.col; g.fillRect(p.x-1,p.y-1,2.5,2.5); g.globalAlpha=1; }
    }
    // player
    g.fillStyle='#e9f0ff'; g.strokeStyle='#a2bdf9'; g.lineWidth=4;
    g.beginPath(); g.arc(player.x,player.y,player.r,0,Math.PI*2); g.fill(); g.stroke();
    // barrel
    g.strokeStyle='#8fb0ff'; g.lineWidth=6; g.lineCap='round';
    g.beginPath(); g.moveTo(player.x,player.y);
    g.lineTo(player.x+Math.cos(player.aim)*player.r*1.2, player.y+Math.sin(player.aim)*player.r*1.2); g.stroke();
  }

  function roundRect(x,y,w,h,r,fill,stroke){
    g.beginPath();
    g.moveTo(x+r,y); g.arcTo(x+w,y,x+w,y+h,r);
    g.arcTo(x+w,y+h,x,y+h,r); g.arcTo(x,y+h,x,y,r);
    g.arcTo(x,y,x+w,y,r);
    if(fill) g.fill(); if(stroke) g.stroke();
  }

  function drawHUD(){
    g.save(); g.translate(12,18); g.fillStyle='#b8c7db'; g.font='16px system-ui';
    g.fillText(`Mode: ${MODES[player.mode]} (L1)`,0,0);
    g.fillText(`Sprint: L3`,0,22);
    g.fillText(`HP: ${player.hp}/${player.maxhp}`,0,44);
    g.restore();
  }

  function draw(){
    g.clearRect(0,0,W,H);
    cam.begin();
    drawWorld();
    cam.end();
    drawHUD();

    // wave fades
    if (WAVES.state==='fadeIn' && WAVES.alpha>0){
      g.fillStyle=`rgba(0,0,0,${WAVES.alpha})`; g.fillRect(0,0,W,H);
      g.fillStyle='rgba(255,255,255,'+(1-WAVES.alpha)+')';
      g.font='bold 28px system-ui'; g.textAlign='center';
      g.fillText(`Wave ${WAVES.idx}`, W*0.5, 80);
    }
  }

  function drawMenu(){
    g.fillStyle='#0f1620'; g.fillRect(0,0,W,H);
    // faint demo background
    cam.begin(); drawWorld(); cam.end();

    g.textAlign='center';
    g.fillStyle='#e5ecff';
    g.font='bold 44px system-ui'; g.fillText('HUNTER-CORE', W*0.5, 120);
    g.font='24px system-ui';
    const opts=['START','TUTORIAL'];
    opts.forEach((o,i)=>{
      const sel=(i===menuIdx);
      g.fillStyle = sel? '#9cc0ff' : '#cbd6f7';
      g.fillText((sel?'> ':'')+o, W*0.5, 200+i*40);
    });
    g.fillStyle='#8090a8'; g.font='14px system-ui';
    g.fillText('A/Cross to select • L-Stick to move', W*0.5, H-28);
  }

  // ---------- Boot ----------
  function resetAll(){ buildMap(); bullets.length=0; parts.length=0; proj.length=0; enemies.length=0; }
  function start(){
    resetAll();
    requestAnimationFrame(tick);
  }
  start();

})();