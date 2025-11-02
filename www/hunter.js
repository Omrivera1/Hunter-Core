/* HUNTER CORE r41
   - Enemy speed tiers (roam / notice / enrage); faster baseline + sprint
   - Spitters with short-range poison vomit (green blobs)
   - Enemy circle collision vs solids/path walls (prevents edge-glitching)
   - Death blood: heavy burst; world-aware (wall splats vs floor pools)
   - Menu: X/❌ button activates selected item
   - Game Over on HP<=0 with bounce and return
   - On-screen-only damage rules kept
*/

(() => {
  // ---------- Canvas / Landscape ----------
  const c = document.getElementById('c') || (() => {
    const el=document.createElement('canvas'); el.id='c'; document.body.appendChild(el); return el;
  })();
  const ctx = c.getContext('2d', { alpha:false });
  const DPR = Math.max(1, Math.min(3, devicePixelRatio||1));
  const isLandscape = () => innerWidth >= innerHeight;
  function resize(){ c.width=innerWidth*DPR; c.height=innerHeight*DPR; c.style.width=innerWidth+'px'; c.style.height=innerHeight+'px'; ctx.setTransform(DPR,0,0,DPR,0,0); }
  addEventListener('resize', resize); addEventListener('orientationchange', resize); resize();

  // ---------- Palette ----------
  const PAL = {
    bgA:'#0e1522', bgB:'#101a2b',
    grid1:'rgba(255,255,255,0.03)', grid2:'rgba(255,255,255,0.015)',
    player:'#e7eefc', playerEdge:'#90a7ff', barrel:'#d7e1ff',
    muzzle:'#ffe6ad',
    tracerHot:'#ffd7a1', tracerFade:'rgba(255,140,40,0)',
    sparkHot:'#ffcc88', sparkCool:'#ff6a3a',
    // deeper blood
    bloodA:'#b60f1a', bloodB:'#6a080d',
    // poison
    poisonA:'#67ff67', poisonB:'rgba(80,255,80,0)',
    // enemies
    enemyBody:'#4b5a6f', enemyEdge:'#b2e2ff', enemyHead:'#d7ecff',
    enrageGlow:'#ff4a4a',
    // UI
    hud:'rgba(255,255,255,0.84)',
    // solids
    solidFill:'rgba(200,220,255,0.20)',
    solidStroke:'rgba(200,220,255,0.42)',
    // ghost
    ghostFill:'rgba(255,255,255,0.07)',
    ghostStroke:'rgba(255,255,255,0.14)',
    // pathway
    pathWall:'#7aa1ff', pathFloor:'rgba(180,200,255,0.08)', pathEdge:'rgba(140,180,255,0.6)',
    // Menu
    title:'#e8ecff', titleEdge:'#86a2ff',
    btnFill:'#172238', btnStroke:'#88aaff', btnText:'#e8f0ff',
    cursor:'#ffd7a1', overlay:'rgba(0,0,0,0.6)',
    // Hurt flash
    hurtFlash:'rgba(180,20,20,'
  };

  // ---------- Scene ----------
  let SCENE='menu'; // 'menu' | 'tutorial' | 'level' | 'gameover'
  let fade=1, hurtFlash=0, gameOverT=0;

  // ---------- World ----------
  const world = {
    W: 3600, H: 2400, grid: 64, bounds: 64,
    friction: 8, accel: 1000,
    baseSpeed: 480, sprint: 1.55,
    recoilPush: 110,
    obstacles: []
  };

  // Shapes
  const rect=(x,y,w,h,solid=true)=>({type:'rect',x,y,w,h,solid});
  const pill=(x,y,r,solid=true)=>({type:'pill',x,y,r,solid});
  const pathway=(x,y,w,h,t=16)=>({type:'path',x,y,w,h,t,solid:true});

  // Layout
  world.obstacles.push(
    rect(900,520,260,80,true), rect(1480,380,120,360,true),
    rect(2100,780,360,90,true), rect(2550,400,160,120,true),
    rect(2900,1200,220,100,true), rect(800,1400,300,90,true),
    rect(1600,1600,500,80,true), rect(2200,1840,160,380,true),
    rect(400,1900,300,120,true), rect(3000,600,90,420,true),
    pill(1200,1000,36,true), pill(1750,900,42,true), pill(2450,1350,38,true),
    pill(3100,1550,46,true), pill(600,600,32,true),
    pathway(1100,1150,420,120,16),
    pathway(2100,1200,520,120,16),
    pathway(1400,1800,480,100,16),
    rect(1850,1120,220,40,false), pill(2600,980,28,false)
  );

  // ---------- Camera ----------
  const cam={x:0,y:0, shake:0, shx:0, shy:0, maxShake:0.6};

  // ---------- Input ----------
  const PAD={LX:0,LY:1,RX:2,RY:3,L1:4,R1:5,L2:6,R2:7,SELECT:8,START:9,L3:10,R3:11, X:0}; // X/❌ is button 0
  const input={move:{x:0,y:0}, aim:{x:1,y:0}, fire:false, l3:false, _l1:false, _firePrev:false, select:false, x:false};
  const pad=()=>{ const a=navigator.getGamepads?.()||[]; for(const p of a) if(p) return p; return null; };
  const dead=v=>Math.abs(v)<0.15?0:v;
  function readInput(){
    const p=pad();
    if(!p){ input.move.x=input.move.y=0; input.fire=false; input.select=false; input.x=false; return; }
    const lx=dead(p.axes[PAD.LX]||0), ly=dead(p.axes[PAD.LY]||0);
    const rx=dead(p.axes[PAD.RX]||0), ry=dead(p.axes[PAD.RY]||0);
    input.move.x=lx; input.move.y=ly;
    if(rx||ry){ input.aim.x=rx; input.aim.y=ry; }
    input.fire = (p.buttons[PAD.R2]?.value??0)>0.5 || !!p.buttons[PAD.R1]?.pressed;
    input.select = !!p.buttons[PAD.START]?.pressed || !!p.buttons[PAD.R1]?.pressed || ((p.buttons[PAD.R2]?.value??0)>0.5);
    input.l3   = !!p.buttons[PAD.L3]?.pressed;
    input.x    = !!p.buttons[PAD.X]?.pressed; // NEW: X/❌
    const l1   = !!p.buttons[PAD.L1]?.pressed;
    if(l1 && !input._l1 && SCENE==='level') cycleFireMode();
    input._l1 = l1;
  }
  const fireEdge = () => input.fire && !input._firePrev;

  // ---------- Player ----------
  const player = {x:world.W/2,y:world.H/2,vx:0,vy:0,r:18,ang:0,aimSmooth:0.18,hp:120,maxHp:120};

  // ---------- Enemies / Poison ----------
  const enemies=[];
  const poison=[]; // green blobs {x,y,vx,vy,age,life}

  function spawnEnemy(){
    let x,y,tries=0;
    do { x=200+Math.random()*(world.W-400); y=200+Math.random()*(world.H-400); tries++; }
    while (tries<20 && Math.hypot(x-player.x,y-player.y) < 600);
    enemies.push({
      x,y, vx:0,vy:0, r:20, // use circle collider
      w:58,h:50, // for drawing only
      hp:220, maxHp:220, alive:true, fade:0, deadFadeTime:0.9,
      touchPulse:16, pulseEvery:0.5, pulseTimer:0,
      state:'wander', tw:0, wx:0, wy:0, sight:700,
      enraged:false, fuse:1.15, lastHitAng:0, bleedTimer:0,
      spitter: Math.random()<0.35, spitCD:0, spitRate:1.0, spitRange:420
    });
  }
  function ensureEnemies(max=10){
    let alive=enemies.filter(e=>e.alive).length;
    while(alive<max){ spawnEnemy(); alive++; }
  }
  ensureEnemies(10);

  // ---------- Weapons / FX ----------
  const bullets=[], sparks=[], blood=[], decals=[], mist=[];
  const weapon = {
    mode:'auto',
    rpmAuto:780, rpmSemiCap:720,
    burstSize:3, burstGap:0.07,
    shotgunPellets:7, shotgunSpread:0.13,
    semiReady:true, cd:0, muzzle:0,
    bursting:false, burstQ:0, burstT:0, burstDir:[1,0]
  };
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

  function cycleFireMode(){ weapon.mode=({auto:'semi',semi:'burst',burst:'shotgun',shotgun:'auto'})[weapon.mode]; }

  function fireRay(dx,dy){
    const sp=1650, tail=0.065;
    const bx=player.x+Math.cos(player.ang)*player.r, by=player.y+Math.sin(player.ang)*player.r;
    bullets.push({x:bx,y:by, px:bx, py:by, vx:dx*sp, vy:dy*sp, age:0, life:1.2, tail});
    weapon.muzzle = 0.05;
    const rec = Math.min(world.recoilPush, world.accel*0.14);
    player.vx -= dx*rec; player.vy -= dy*rec;
  }

  function tryShoot(dx,dy,edge){
    if(SCENE!=='level') return;
    if(weapon.mode==='auto'){
      if(weapon.cd<=0 && input.fire){ fireRay(dx,dy); weapon.cd = 60/weapon.rpmAuto; }
    } else if(weapon.mode==='semi'){
      if(edge && weapon.cd<=0 && weapon.semiReady){
        fireRay(dx,dy); weapon.semiReady=false; weapon.cd = Math.max(0.06, 60/weapon.rpmSemiCap);
      }
    } else if(weapon.mode==='burst'){
      if(edge && !weapon.bursting && weapon.semiReady){
        weapon.bursting=true; weapon.semiReady=false; weapon.burstQ=weapon.burstSize; weapon.burstT=0; weapon.burstDir=[dx,dy];
        weapon.cd = 60/weapon.rpmAuto;
      }
    } else { // shotgun
      if(weapon.cd<=0 && input.fire){
        cam.shake = Math.min(cam.maxShake, cam.shake + 0.20);
        const n=weapon.shotgunPellets, s=weapon.shotgunSpread;
        for(let i=0;i<n;i++){ const a=Math.atan2(dy,dx)+(Math.random()*2-1)*s; fireRay(Math.cos(a),Math.sin(a)); }
        weapon.cd = 0.22;
      }
    }
  }

  // FX spawners
  function spawnSparks(x,y,ang,nx=0,ny=0){
    const N=18+(Math.random()*8|0);
    for(let i=0;i<N;i++){
      const a=ang+(Math.random()*0.8-0.4), sp=320+Math.random()*360;
      sparks.push({x:x+nx*1.5,y:y+ny*1.5,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,age:0,life:0.24+Math.random()*0.28});
    }
    decals.push({type:'debris',x,y,age:0,life:6.0,rot:Math.random()*6});
  }
  function spawnBloodSpray(x,y,ang, power=1){
    const N=(24+(Math.random()*14|0))*power;
    for(let i=0;i<N;i++){
      const a=ang+(Math.random()*1.2-0.6), sp=200+Math.random()*300*power;
      blood.push({x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,age:0,life:0.28+Math.random()*0.36, kind:'flying'});
    }
  }
  function spawnDeathBurst(x,y,ang){
    // Heavier mist + spray
    const N=32+(Math.random()*16|0);
    for(let i=0;i<N;i++){
      const a=ang+(Math.random()*1.2-0.6), sp=200+Math.random()*280;
      mist.push({x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,age:0,life:0.6+Math.random()*0.5});
    }
    spawnBloodSpray(x,y,ang, 1.4);
  }

  // ---------- Geometry ----------
  // circle vs rect push
  function circleRectPush(cx,cy,r, rx,ry,rw,rh){
    const clx=clamp(cx,rx,rx+rw), cly=clamp(cy,ry,ry+rh);
    const dx=cx-clx, dy=cy-cly, d2=dx*dx+dy*dy;
    if(d2>r*r) return null;
    const d=Math.sqrt(d2)||1, nx=dx/d, ny=dy/d;
    return {nx,ny,pen:r-d, hitX:clx, hitY:cly};
  }
  // circle vs circle push
  function circleCirclePush(cx,cy,r, ox,oy,or){
    const dx=cx-ox, dy=cy-oy, rr=r+or, d2=dx*dx+dy*dy;
    if(d2>rr*rr) return null;
    const d=Math.sqrt(d2)||1, nx=dx/d, ny=dy/d;
    return {nx,ny,pen:rr-d, hitX:ox+nx*or, hitY:oy+ny*or};
  }
  // segment-rect hit
  function segRectHit(x1,y1,x2,y2, rx,ry,rw,rh){
    let tmin=0, tmax=1, nx=0, ny=0;
    const dx=x2-x1, dy=y2-y1;
    function slab(p, dp, smin, smax, npx, npy){
      if(Math.abs(dp)<1e-6){ if(p<smin || p>smax) return false; return true; }
      let t1=(smin-p)/dp, t2=(smax-p)/dp, n1=[npx,npy], n2=[-npx,-npy];
      if(t1>t2){ [t1,t2]=[t2,t1]; [n1,n2]=[n2,n1]; }
      if(t1>tmin){ tmin=t1; nx=n1[0]; ny=n1[1]; }
      if(t2<tmax) tmax=t2;
      return tmin<=tmax;
    }
    if(!slab(x1,dx,rx,rx+rw,1,0)) return null;
    if(!slab(y1,dy,ry,ry+rh,0,1)) return null;
    if(tmin<0 || tmin>1) return null;
    return {x:x1+dx*tmin, y:y1+dy*tmin, nx, ny};
  }
  // Iterate the walls of a path
  function forEachSolid(o, fn){
    if(o.type==='path'){
      const {x,y,w,h,t}=o;
      fn({x:x,y:y,width:w,height:t});
      fn({x:x,y:y+h-t,width:w,height:t});
      fn({x:x,y:y+t,width:t,height:h-2*t});
      fn({x:x+w-t,y:y+t,width:t,height:h-2*t});
    } else if(o.type==='rect' && o.solid){
      fn({x:o.x,y:o.y,width:o.w,height:o.h});
    } else if(o.type==='pill' && o.solid){
      fn({x:o.x-o.r,y:o.y-o.r,width:o.r*2,height:o.r*2, pill:o});
    }
  }

  // ---------- Menu / Demo ----------
  const menu = {
    titleY:-160, titleVy:0, titleTarget:120, bounce:0.58, gravity:1200,
    cursor:{x:0,y:0}, buttons:[{label:'START: LEVEL ONE', id:'start'}, {label:'INSTRUCTIONS / TUTORIAL', id:'tutorial'}]
  };
  const demo = { t:0, px:world.W/2, py:world.H/2 };
  const viewport=()=>({vw:c.width/DPR, vh:c.height/DPR});
  const onScreen=(x,y,pad=0)=>{ const {vw,vh}=viewport(); return x>=cam.x-pad && x<=cam.x+vw+pad && y>=cam.y-pad && y<=cam.y+vh+pad; };

  function startLevel(){
    SCENE='level'; fade=1; player.x=world.W/2; player.y=world.H/2; player.vx=player.vy=0; player.hp=player.maxHp=120;
    enemies.length=0; poison.length=0; bullets.length=0; decals.length=0; blood.length=0; mist.length=0; ensureEnemies(10);
  }

  c.addEventListener('pointerdown', e=>{
    const rect=c.getBoundingClientRect(); const x=(e.clientX-rect.left), y=(e.clientY-rect.top);
    if(!isLandscape()) return;
    if(SCENE==='menu'){
      const {vw,vh}=viewport(); const btns=layoutMenu(vw,vh).btns;
      for(const b of btns){ if(x>=b.x && x<=b.x+b.w && y>=b.y && y<=b.y+b.h){ if(b.id==='start') startLevel(); else SCENE='tutorial'; } }
      menu.cursor.x=x; menu.cursor.y=y;
    } else if(SCENE==='tutorial'){ SCENE='menu'; }
    else if(SCENE==='gameover'){ SCENE='menu'; }
  });

  function layoutMenu(vw,vh){
    const cx=vw/2, cy=vh/2;
    const btnW=340, btnH=50, gap=14;
    return {
      cx, cy,
      btns:[
        {x:cx-btnW/2, y:cy+40, w:btnW, h:btnH, id:'start', label:'START: LEVEL ONE'},
        {x:cx-btnW/2, y:cy+40+btnH+gap, w:btnW, h:btnH, id:'tutorial', label:'INSTRUCTIONS / TUTORIAL'}
      ]
    };
  }

  function updateDemo(dt){
    demo.t+=dt;
    const speed=120, a=demo.t*0.6;
    demo.px = clamp(demo.px + Math.cos(a)*speed*dt, world.bounds, world.W-world.bounds);
    demo.py = clamp(demo.py + Math.sin(a*1.2)*speed*dt, world.bounds, world.H-world.bounds);
  }

  // ---------- Update ----------
  function update(dt){
    readInput();

    if(!isLandscape()){ return; }

    // MENU
    if(SCENE==='menu'){
      // title drop
      if(menu.titleY < menu.titleTarget){
        menu.titleVy += menu.gravity*dt; menu.titleY += menu.titleVy*dt;
        if(menu.titleY > menu.titleTarget){
          menu.titleY = menu.titleTarget; menu.titleVy = -menu.titleVy*0.58;
          if(Math.abs(menu.titleVy) < 60) menu.titleVy = 0;
        }
      }
      // background demo
      updateDemo(dt);
      // cursor stick
      const {vw,vh}=viewport(); const L=layoutMenu(vw,vh);
      if(!menu.cursor.init){ menu.cursor.x=L.cx; menu.cursor.y=L.cy+100; menu.cursor.init=true; }
      menu.cursor.x = clamp(menu.cursor.x + input.move.x*380*dt, 0, vw);
      menu.cursor.y = clamp(menu.cursor.y + input.move.y*380*dt, 0, vh);
      // X/❌ activates focused button
      if(input.x || input.select){
        const cx=menu.cursor.x, cy=menu.cursor.y;
        for(const b of L.btns){ if(cx>=b.x && cx<=b.x+b.w && cy>=b.y && cy<=b.y+b.h){ if(b.id==='start') startLevel(); else SCENE='tutorial'; } }
      }
      return;
    }

    if(SCENE==='tutorial'){
      if(input._l1 || pad()?.buttons[PAD.SELECT]?.pressed || input.x){ SCENE='menu'; }
      return;
    }

    if(SCENE==='gameover'){
      gameOverT += dt; if(gameOverT>2.2){ SCENE='menu'; }
      return;
    }

    // LEVEL
    const targ=Math.atan2(input.aim.y,input.aim.x);
    let da=((targ-player.ang+Math.PI*3)%(Math.PI*2))-Math.PI; player.ang+=da*player.aimSmooth;

    // move
    const im=Math.hypot(input.move.x,input.move.y); const mx=im?input.move.x/im:0, my=im?input.move.y/im:0;
    const spd=world.baseSpeed*(input.l3?world.sprint:1);
    const dvx=mx*spd, dvy=my*spd;
    player.vx+=(dvx-player.vx)*Math.min(1,dt*10);
    player.vy+=(dvy-player.vy)*Math.min(1,dt*10);
    const f=Math.exp(-world.friction*dt); player.vx*=f; player.vy*=f;
    player.x+=player.vx*dt; player.y+=player.vy*dt;

    // player collisions
    player.x = clamp(player.x, world.bounds+player.r, world.W-world.bounds-player.r);
    player.y = clamp(player.y, world.bounds+player.r, world.H-world.bounds-player.r);
    for(const o of world.obstacles){
      if(o.type==='rect' && o.solid){
        const res=circleRectPush(player.x,player.y,player.r, o.x,o.y,o.w,o.h);
        if(res){ player.x+=res.nx*res.pen; player.y+=res.ny*res.pen; const vn=player.vx*res.nx+player.vy*res.ny; if(vn<0){ player.vx-=vn*res.nx; player.vy-=vn*res.ny; } }
      } else if(o.type==='pill' && o.solid){
        const cc=circleCirclePush(player.x,player.y,player.r, o.x,o.y,o.r);
        if(cc){ player.x+=cc.nx*cc.pen; player.y+=cc.ny*cc.pen; const vn=player.vx*cc.nx+player.vy*cc.ny; if(vn<0){ player.vx-=vn*cc.nx; player.vy-=vn*cc.ny; } }
      } else if(o.type==='path'){
        forEachSolid(o, R=>{
          const res=circleRectPush(player.x,player.y,player.r, R.x,R.y,R.width,R.height);
          if(res){ player.x+=res.nx*res.pen; player.y+=res.ny*res.pen; const vn=player.vx*res.nx+player.vy*res.ny; if(vn<0){ player.vx-=vn*res.nx; player.vy-=vn*res.ny; } }
        });
      }
    }

    // camera
    const {vw,vh}=viewport();
    cam.x = clamp(player.x - vw/2, 0, world.W-vw);
    cam.y = clamp(player.y - vh/2, 0, world.H-vh);
    cam.shake = Math.min(cam.maxShake, Math.max(0, cam.shake - dt*2.3));
    cam.shx = (Math.random()*2-1)*cam.shake*7; cam.shy = (Math.random()*2-1)*cam.shake*7;

    // shooting
    const al=Math.hypot(input.aim.x,input.aim.y)||1, dx=input.aim.x/al, dy=input.aim.y/al;
    weapon.cd = Math.max(0, weapon.cd - dt);
    weapon.muzzle = Math.max(0, weapon.muzzle - dt);
    if(weapon.bursting){
      weapon.burstT -= dt;
      if(weapon.burstQ>0 && weapon.burstT<=0){
        const [bx,by]=weapon.burstDir; fireRay(bx,by); weapon.burstQ--; weapon.burstT = weapon.burstGap;
      }
      if(weapon.burstQ===0){ weapon.bursting=false; }
    }
    if(weapon.mode==='semi' || weapon.mode==='burst'){ if(!input.fire) weapon.semiReady=true; }
    const edge = fireEdge(); tryShoot(dx,dy,edge);
    input._firePrev = input.fire;

    // bullets step
    for (let i=bullets.length-1;i>=0;i--){
      const b=bullets[i]; b.age+=dt; b.px=b.x; b.py=b.y; b.x+=b.vx*dt; b.y+=b.vy*dt;
      let removed=false;
      for(const o of world.obstacles){
        if(removed) break;
        if(o.type==='rect' && o.solid){
          const hit=segRectHit(b.px,b.py,b.x,b.y, o.x,o.y,o.w,o.h);
          if(hit){ spawnSparks(hit.x,hit.y, Math.atan2(b.vy,b.vx), hit.nx,hit.ny); cam.shake=Math.min(cam.maxShake, cam.shake+0.08); bullets.splice(i,1); removed=true; }
        } else if(o.type==='pill' && o.solid){
          const cc=circleCirclePush(b.x,b.y,2, o.x,o.y,o.r);
          if(cc){ spawnSparks(cc.hitX,cc.hitY, Math.atan2(b.vy,b.vx), cc.nx,cc.ny); cam.shake=Math.min(cam.maxShake, cam.shake+0.08); bullets.splice(i,1); removed=true; }
        } else if(o.type==='path'){
          forEachSolid(o, R=>{
            if(removed) return;
            const hit=segRectHit(b.px,b.py,b.x,b.y, R.x,R.y,R.width,R.height);
            if(hit){ spawnSparks(hit.x,hit.y, Math.atan2(b.vy,b.vx), hit.nx,hit.ny); cam.shake=Math.min(cam.maxShake, cam.shake+0.08); bullets.splice(i,1); removed=true; }
          });
        }
      }
      // enemy hits
      for(const e of enemies){
        if(removed || !e.alive) continue;
        const dx=b.x-e.x, dy=b.y-e.y;
        if(dx*dx+dy*dy < (e.r+3)*(e.r+3)){
          e.hp = Math.max(0, e.hp - 14);
          e.vx += b.vx*0.02; e.vy += b.vy*0.02;
          const ang=Math.atan2(b.vy,b.vx); e.lastHitAng=ang; spawnBloodSpray(b.x,b.y, ang, 0.8);
          cam.shake = Math.min(cam.maxShake, cam.shake + 0.06);
          e.bleedTimer = 0.1;
          if(!e.enraged && e.hp <= e.maxHp*0.34){ e.enraged=true; e.fuse=1.0; }
          if(e.hp===0 && e.alive){ e.alive=false; e.fade=0; spawnDeathBurst(e.x,e.y, e.lastHitAng); }
          bullets.splice(i,1); removed=true; break;
        }
      }
      // bounds
      if(!removed && (b.x<world.bounds || b.x>world.W-world.bounds || b.y<world.bounds || b.y>world.H-world.bounds)){
        let nx=0,ny=0; if(b.x<world.bounds) nx=1; else if(b.x>world.W-world.bounds) nx=-1; if(b.y<world.bounds) ny=1; else if(b.y>world.H-world.bounds) ny=-1;
        spawnSparks(b.x,b.y, Math.atan2(b.vy,b.vx), nx,ny); bullets.splice(i,1);
      }
      if(!removed && b.age>b.life){ bullets.splice(i,1); }
    }

    // enemies AI
    for(const e of enemies){
      if(!e.alive){ e.fade+=dt; continue; }

      // distance to player
      const dxp=player.x-e.x, dyp=player.y-e.y, dist=Math.hypot(dxp,dyp)||1, ux=dxp/dist, uy=dyp/dist;

      // state: roam → notice → (if low HP) enraged flagged (speed tier bumps handled below)
      if(dist<e.sight) e.state='notice';
      const low = e.hp <= e.maxHp*0.34;
      const tierSpeed = (()=>{ // three tiers
        const baseRoam = 190;        // roam
        const notice   = 260;        // when noticing you
        const enrage   = 370;        // low HP sprint
        if(low) return enrage;
        return e.state==='notice' ? notice : baseRoam;
      })();

      // move target
      if(e.state==='wander'){
        e.tw -= dt; if(e.tw<=0){ const a=Math.random()*Math.PI*2, m=110+Math.random()*140; e.wx=Math.cos(a)*m; e.wy=Math.sin(a)*m; e.tw=0.8+Math.random()*1.2; }
        e.vx += (e.wx-e.vx)*Math.min(1,dt*2.1); e.vy += (e.wy-e.vy)*Math.min(1,dt*2.1);
      } else {
        e.vx += (ux*tierSpeed - e.vx)*Math.min(1,dt*3.2);
        e.vy += (uy*tierSpeed - e.vy)*Math.min(1,dt*3.2);
      }

      // integrate / damp
      const ef=Math.exp(-11*dt); e.vx*=ef; e.vy*=ef; e.x+=e.vx*dt; e.y+=e.vy*dt;

      // circle collisions against all solids/path walls (multi-pass to kill tunneling)
      for(let pass=0; pass<5; pass++){
        for(const o of world.obstacles){
          if(o.type==='rect' && o.solid){
            const res=circleRectPush(e.x,e.y,e.r, o.x,o.y,o.w,o.h);
            if(res){ e.x+=res.nx*res.pen; e.y+=res.ny*res.pen; const vn=e.vx*res.nx+e.vy*res.ny; if(vn<0){ e.vx-=vn*res.nx; e.vy-=vn*res.ny; } }
          } else if(o.type==='pill' && o.solid){
            const cc=circleCirclePush(e.x,e.y,e.r, o.x,o.y,o.r);
            if(cc){ e.x+=cc.nx*cc.pen; e.y+=cc.ny*cc.pen; const vn=e.vx*cc.nx+e.vy*cc.ny; if(vn<0){ e.vx-=vn*cc.nx; e.vy-=vn*cc.ny; } }
          } else if(o.type==='path'){
            forEachSolid(o, R=>{
              const res=circleRectPush(e.x,e.y,e.r, R.x,R.y,R.width,R.height);
              if(res){ e.x+=res.nx*res.pen; e.y+=res.ny*res.pen; const vn=e.vx*res.nx+e.vy*res.ny; if(vn<0){ e.vx-=vn*res.nx; e.vy-=vn*res.ny; } }
            });
          }
        }
      }

      // contact pulses (on-screen only)
      const px=e.x-player.x, py=e.y-player.y, pr=player.r+e.r-6;
      if(px*px+py*py<pr*pr){
        const d=Math.hypot(px,py)||1, nx=px/d, ny=py/d, push=(pr-d);
        e.x += nx*push*0.6; e.y += ny*push*0.6;
        player.x -= nx*push*0.4; player.y -= ny*push*0.4;
        if(onScreen(e.x,e.y)){
          e.pulseTimer -= dt;
          if(e.pulseTimer<=0){ e.pulseTimer = e.pulseEvery; player.hp = Math.max(0, player.hp - e.touchPulse); hurtFlash = 0.35; cam.shake = Math.min(cam.maxShake, cam.shake+0.05); }
        }
      } else {
        e.pulseTimer = Math.max(0.15, Math.min(e.pulseTimer, e.pulseEvery));
      }

      // spitter behavior
      e.spitCD = Math.max(0, e.spitCD - dt);
      if(e.spitter && dist<e.spitRange && onScreen(e.x,e.y) && e.spitCD<=0){
        // lob a short-range poison blob roughly toward player, slight spread
        const a=Math.atan2(uy,ux) + (Math.random()*0.4-0.2);
        const sp=260 + Math.random()*60;
        poison.push({x:e.x, y:e.y, vx:Math.cos(a)*sp, vy:Math.sin(a)*sp, age:0, life:0.9});
        e.spitCD = 0.9 + Math.random()*0.6;
      }

      // bleeding trail when hurt
      e.bleedTimer -= dt;
      if(e.hp<e.maxHp && e.bleedTimer<=0){
        e.bleedTimer = 0.10 + Math.random()*0.14;
        // small droplet (will land as floor pool)
        blood.push({x:e.x,y:e.y,vx:(Math.random()*2-1)*60,vy:(Math.random()*2-1)*60,age:0,life:0.35, kind:'flying'});
      }

      // enraged fuse / explosion (on-screen only)
      if(e.enraged){
        e.fuse -= dt;
        if(e.fuse<=0){
          const ex=e.x, ey=e.y; cam.shake=Math.min(cam.maxShake, cam.shake+0.58);
          spawnDeathBurst(ex,ey, e.lastHitAng);
          if(onScreen(ex,ey)){
            const kx=player.x-ex, ky=player.y-ey, dd=Math.hypot(kx,ky)||1, fall=Math.max(0,1-dd/280);
            player.vx += (kx/dd)*300*fall; player.vy += (ky/dd)*300*fall;
            player.hp = Math.max(0, player.hp - 40*fall); hurtFlash = 0.42;
          }
          e.alive=false; e.fade=0;
        }
      }
    }

    // poison step (green)
    for(let i=poison.length-1;i>=0;i--){
      const pz=poison[i]; pz.age+=dt; pz.x+=pz.vx*dt; pz.y+=pz.vy*dt;
      // collide with walls: splat green decal and remove
      let hit=false;
      for(const o of world.obstacles){
        if(hit) break;
        if(o.type==='rect' && o.solid){
          const res=circleRectPush(pz.x,pz.y,3, o.x,o.y,o.w,o.h);
          if(res){ decals.push({type:'poisonSplat',x:pz.x,y:pz.y,age:0,life:3,rot:Math.random()*6}); hit=true; }
        } else if(o.type==='pill' && o.solid){
          const cc=circleCirclePush(pz.x,pz.y,3, o.x,o.y,o.r);
          if(cc){ decals.push({type:'poisonSplat',x:cc.hitX,y:cc.hitY,age:0,life:3,rot:Math.random()*6}); hit=true; }
        } else if(o.type==='path'){
          forEachSolid(o, R=>{
            if(hit) return;
            const res=circleRectPush(pz.x,pz.y,3, R.x,R.y,R.width,R.height);
            if(res){ decals.push({type:'poisonSplat',x:pz.x,y:pz.y,age:0,life:3,rot:Math.random()*6}); hit=true; }
          });
        }
      }
      // hit player (on-screen only)
      if(!hit){
        const dx=pz.x-player.x, dy=pz.y-player.y;
        if(dx*dx+dy*dy<(player.r+6)*(player.r+6) && onScreen(pz.x,pz.y)){
          player.hp = Math.max(0, player.hp - 12); hurtFlash = 0.32; hit=true;
        }
      }
      if(hit || pz.age>pz.life) poison.splice(i,1);
    }

    // blood particles: wall vs floor interaction
    for(let i=blood.length-1;i>=0;i--){
      const b=blood[i]; b.age+=dt; b.vx*=0.98; b.vy=b.vy*0.98+600*dt*0.22; b.x+=b.vx*dt; b.y+=b.vy*dt;
      let wHit=null;
      for(const o of world.obstacles){
        if(wHit) break;
        if(o.type==='rect' && o.solid){
          const res=circleRectPush(b.x,b.y,2.2, o.x,o.y,o.w,o.h); if(res) wHit=res;
        } else if(o.type==='pill' && o.solid){
          const cc=circleCirclePush(b.x,b.y,2.2, o.x,o.y,o.r); if(cc) wHit=cc;
        } else if(o.type==='path'){
          forEachSolid(o, R=>{ if(wHit) return; const res=circleRectPush(b.x,b.y,2.2, R.x,R.y,R.width,R.height); if(res) wHit=res; });
        }
      }
      if(wHit){
        // wall splat then remove
        decals.push({type:'bloodWall',x:b.x,y:b.y,age:0,life:6.5,rot:Math.random()*6});
        blood.splice(i,1);
      } else if(b.age>b.life){
        // floor pool
        decals.push({type:'bloodPool',x:b.x,y:b.y,age:0,life:8.5,rot:Math.random()*6});
        blood.splice(i,1);
      }
    }

    // mist drift
    for(let i=mist.length-1;i>=0;i--){ const m=mist[i]; m.age+=dt; m.vx*=0.97; m.vy=m.vy*0.97+600*dt*0.12; m.x+=m.vx*dt; m.y+=m.vy*dt; if(m.age>m.life) mist.splice(i,1); }
    // sparks + decals
    for(let i=sparks.length-1;i>=0;i--){ const s=sparks[i]; s.age+=dt; s.vx*=0.98; s.vy=s.vy*0.98+600*dt*0.18; s.x+=s.vx*dt; s.y+=s.vy*dt; if(s.age>s.life) sparks.splice(i,1); }
    for(let i=decals.length-1;i>=0;i--){ const d=decals[i]; d.age+=dt; if(d.age>d.life) decals.splice(i,1); }

    // cull / maintain enemy count
    for(let i=enemies.length-1;i>=0;i--){ const e=enemies[i]; if(!e.alive && e.fade>e.deadFadeTime){ enemies.splice(i,1); } }
    ensureEnemies(10);

    // player hurt flash & game over
    if(hurtFlash>0) hurtFlash = Math.max(0, hurtFlash - dt*1.8);
    if(player.hp<=0 && SCENE==='level'){ SCENE='gameover'; gameOverT=0; }

    // fade-in
    if(fade>0) fade=Math.max(0, fade - dt*1.2);
  }

  // ---------- Render ----------
  function drawGrid(){
    const {vw,vh}=viewport();
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
  function drawPathways(){
    for(const o of world.obstacles){
      if(o.type!=='path') continue;
      const ix=o.x+o.t, iy=o.y+o.t, iw=o.w-2*o.t, ih=o.h-2*o.t;
      ctx.fillStyle=PAL.solidFill; ctx.strokeStyle=PAL.solidStroke; ctx.lineWidth=1.6;
      ctx.fillRect(o.x-cam.x+cam.shx, o.y-cam.y+cam.shy, o.w, o.h);
      ctx.strokeRect(o.x-cam.x+cam.shx, o.y-cam.y+cam.shy, o.w, o.h);
      ctx.fillStyle=PAL.pathFloor; ctx.strokeStyle=PAL.pathEdge; ctx.lineWidth=1.2;
      ctx.fillRect(ix-cam.x+cam.shx, iy-cam.y+cam.shy, iw, ih);
      ctx.strokeRect(ix-cam.x+cam.shx, iy-cam.y+cam.shy, iw, ih);
    }
  }
  function drawObstacles(){
    ctx.lineWidth=1.6;
    for(const o of world.obstacles){
      if(o.type==='path') continue;
      if(o.type==='rect'){
        const f=o.solid?PAL.solidFill:PAL.ghostFill, s=o.solid?PAL.solidStroke:PAL.ghostStroke;
        ctx.fillStyle=f; ctx.strokeStyle=s;
        ctx.fillRect(o.x-cam.x+cam.shx, o.y-cam.y+cam.shy, o.w, o.h);
        ctx.strokeRect(o.x-cam.x+cam.shx, o.y-cam.y+cam.shy, o.w, o.h);
      } else {
        const f=o.solid?PAL.solidFill:PAL.ghostFill, s=o.solid?PAL.solidStroke:PAL.ghostStroke;
        ctx.fillStyle=f; ctx.strokeStyle=s;
        ctx.beginPath(); ctx.arc(o.x-cam.x+cam.shx, o.y-cam.y+cam.shy, o.r, 0, Math.PI*2); ctx.fill(); ctx.stroke();
      }
    }
  }
  function drawDecals(){
    for(const d of decals){
      ctx.save(); ctx.translate(d.x-cam.x+cam.shx, d.y-cam.y+cam.shy); ctx.rotate(d.rot);
      const k=Math.max(0,1-d.age/d.life);
      if(d.type==='debris'){ ctx.fillStyle=`rgba(220,220,220,${0.18*k})`; ctx.fillRect(-8,-3,16,6); }
      else if(d.type==='bloodPool'){ ctx.fillStyle=`rgba(150,15,25,${0.30*k})`; ctx.beginPath(); ctx.ellipse(0,0,30,22,0,0,Math.PI*2); ctx.fill(); }
      else if(d.type==='bloodWall'){ ctx.fillStyle=`rgba(150,15,25,${0.42*k})`; ctx.beginPath(); ctx.ellipse(0,0,10,6,0,0,Math.PI*2); ctx.fill(); }
      else if(d.type==='poisonSplat'){ ctx.fillStyle=`rgba(80,255,80,${0.38*k})`; ctx.beginPath(); ctx.ellipse(0,0,12,8,0,0,Math.PI*2); ctx.fill(); }
      ctx.restore();
    }
  }
  function drawEnemies(){
    for(const e of enemies){
      if(!e.alive) continue;
      const x=e.x-cam.x+cam.shx, y=e.y-cam.y+cam.shy, w=e.w, h=e.h, r=10;
      let bodyFill = e.enraged ? `rgba(255,74,74,${0.5 + 0.35*((Math.sin(performance.now()/90)+1)/2)})` : PAL.enemyBody;
      ctx.fillStyle=bodyFill; ctx.strokeStyle=PAL.enemyEdge; ctx.lineWidth=2;
      // body capsule visual
      ctx.beginPath();
      ctx.moveTo(x-w/2+r, y-h/2);
      ctx.arcTo(x+w/2, y-h/2, x+w/2, y+h/2, r);
      ctx.arcTo(x+w/2, y+h/2, x-w/2, y+h/2, r);
      ctx.arcTo(x-w/2, y+h/2, x-w/2, y-h/2, r);
      ctx.arcTo(x-w/2, y-h/2, x+w/2, y-h/2, r);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      // head
      ctx.beginPath(); ctx.arc(x, y-h*0.35, 14, 0, Math.PI*2); ctx.fillStyle=PAL.enemyHead; ctx.fill();
      // spitter mark
      if(e.spitter){ ctx.fillStyle='rgba(80,255,80,0.85)'; ctx.fillRect(x-3,y+h*0.1,6,6); }
      // hp pips
      const pips=Math.ceil((e.hp/e.maxHp)*8), top=y-h/2-10;
      for(let i=0;i<8;i++){ ctx.fillStyle= i<pips ? '#f85a5a' : 'rgba(255,255,255,0.15)'; ctx.fillRect(x-48+i*12, top, 8, 4); }
    }
  }
  function drawPlayer(){
    const x=player.x-cam.x+cam.shx, y=player.y-cam.y+cam.shy, bl=28;
    ctx.beginPath(); ctx.arc(x,y,player.r,0,Math.PI*2); ctx.fillStyle=PAL.player; ctx.fill(); ctx.lineWidth=2; ctx.strokeStyle=PAL.playerEdge; ctx.stroke();
    ctx.strokeStyle=PAL.barrel; ctx.lineWidth=6; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x+Math.cos(player.ang)*bl, y+Math.sin(player.ang)*bl); ctx.stroke();
    if(weapon.muzzle>0){ const m=10+10*(weapon.muzzle/0.05); ctx.fillStyle=PAL.muzzle; ctx.beginPath(); ctx.arc(x+Math.cos(player.ang)*bl, y+Math.sin(player.ang)*bl, m*0.5, 0, Math.PI*2); ctx.fill(); }
  }
  function drawFX(){
    for(const s of sparks){
      const r=2*(1-s.age/s.life);
      ctx.fillStyle = s.age < s.life*0.5 ? PAL.sparkHot : PAL.sparkCool;
      ctx.beginPath(); ctx.arc(s.x-cam.x+cam.shx, s.y-cam.y+cam.shy, Math.max(0,r), 0, Math.PI*2); ctx.fill();
    }
    for(const m of mist){
      const r=4.2*(1-m.age/m.life);
      ctx.fillStyle = `rgba(150,15,25,${0.38*(1-m.age/m.life)})`;
      ctx.beginPath(); ctx.arc(m.x-cam.x+cam.shx, m.y-cam.y+cam.shy, Math.max(0,r), 0, Math.PI*2); ctx.fill();
    }
    // poison blobs
    for(const pz of poison){
      const gx=pz.x-cam.x+cam.shx, gy=pz.y-cam.y+cam.shy;
      const grad=ctx.createRadialGradient(gx,gy,0, gx,gy,8);
      grad.addColorStop(0,'rgba(80,255,80,0.9)');
      grad.addColorStop(1,'rgba(80,255,80,0.0)');
      ctx.fillStyle=grad; ctx.beginPath(); ctx.arc(gx,gy,8,0,Math.PI*2); ctx.fill();
    }
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
  function drawHUD(){
    ctx.fillStyle=PAL.hud; ctx.font='14px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    ctx.fillText(`Mode: ${weapon.mode.toUpperCase()} (L1)`, 16, 22);
    ctx.fillText(`Sprint: L3`, 16, 40);
    ctx.fillText(`HP: ${Math.ceil(player.hp)}/${player.maxHp}`, 16, 58);
    if(fade>0){ ctx.fillStyle=`rgba(0,0,0,${fade})`; ctx.fillRect(0,0,c.width/DPR,c.height/DPR); }
    if(hurtFlash>0){ ctx.fillStyle=PAL.hurtFlash + (0.5*hurtFlash) + ')'; ctx.fillRect(0,0,c.width/DPR,c.height/DPR); }
  }

  // ----- High-level renders -----
  function renderMenu(){
    const {vw,vh}=viewport();
    // demo camera
    cam.x = clamp(demo.px - vw/2, 0, world.W-vw);
    cam.y = clamp(demo.py - vh/2, 0, world.H-vh);
    drawGrid(); drawPathways(); drawObstacles();
    ctx.fillStyle='rgba(0,0,0,0.45)'; ctx.fillRect(0,0,vw,vh);

    // title
    ctx.save(); ctx.translate(vw/2, menu.titleY);
    ctx.font='bold 48px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    ctx.fillStyle=PAL.title; ctx.strokeStyle=PAL.titleEdge; ctx.lineWidth=3;
    const txt='HUNTER CORE'; const m=ctx.measureText(txt);
    ctx.strokeText(txt, -m.width/2, 0); ctx.fillText(txt, -m.width/2, 0); ctx.restore();

    // buttons
    const L=layoutMenu(vw,vh);
    for(const b of L.btns){
      ctx.fillStyle=PAL.btnFill; ctx.strokeStyle=PAL.btnStroke; ctx.lineWidth=2;
      ctx.fillRect(b.x, b.y, b.w, b.h); ctx.strokeRect(b.x,b.y,b.w,b.h);
      ctx.fillStyle=PAL.btnText; ctx.font='16px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
      const mt=ctx.measureText(b.label);
      ctx.fillText(b.label, b.x + (b.w-mt.width)/2, b.y + 32);
    }
    // cursor
    if(!menu.cursor.init){ menu.cursor.x=L.cx; menu.cursor.y=L.cy+100; }
    ctx.fillStyle=PAL.cursor; ctx.beginPath(); ctx.arc(menu.cursor.x, menu.cursor.y, 6, 0, Math.PI*2); ctx.fill();
  }
  function renderTutorial(){
    const {vw,vh}=viewport();
    const g=ctx.createLinearGradient(0,0,vw,vh); g.addColorStop(0,PAL.bgA); g.addColorStop(1,PAL.bgB);
    ctx.fillStyle=g; ctx.fillRect(0,0,vw,vh);
    ctx.fillStyle=PAL.overlay; ctx.fillRect(0,0,vw,vh);
    ctx.fillStyle='#ffffff';
    ctx.font='bold 28px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    ctx.fillText('INSTRUCTIONS', 40, 70);
    ctx.font='16px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    const lines=[
      'Move: Left Stick (L3 = Sprint)    Aim: Right Stick',
      'Fire: R2 / R1     Toggle Mode: L1 (AUTO / SEMI / BURST / SHOTGUN)',
      'Zombies: contact pulses; spitters vomit short-range poison.',
      'At low HP they sprint and may explode. Blood splashes on walls/floor.',
      'Opaque = solid. Pathways show solid borders with a walkable lane.',
      'Damage from enemies/explosions applies only if threat is visible.',
      'Press L1 / SELECT / X(❌) or tap to go back.'
    ];
    let y=110; for(const ln of lines){ ctx.fillText(ln, 40, y); y+=26; }
  }
  function renderLevel(){
    drawGrid(); drawPathways(); drawObstacles(); drawDecals(); drawEnemies(); drawFX(); drawBullets(); drawPlayer(); drawHUD();
  }
  function renderGameOver(){
    const {vw,vh}=viewport();
    ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(0,0,vw,vh);
    const t=gameOverT; const s=1 + 0.12*Math.sin(Math.min(1,t)*Math.PI);
    ctx.save(); ctx.translate(vw/2, vh/2); ctx.scale(s,s);
    ctx.font='bold 52px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    ctx.fillStyle=PAL.title; ctx.strokeStyle=PAL.titleEdge; ctx.lineWidth=4;
    const txt='GAME OVER'; const m=ctx.measureText(txt);
    ctx.strokeText(txt, -m.width/2, 0); ctx.fillText(txt, -m.width/2, 0);
    ctx.restore();
  }

  // ---------- Main Loop ----------
  function frame(now){
    const dt=Math.min(0.033, ((now-(frame.t||now))/1000)); frame.t=now;
    update(dt);

    if(!isLandscape()){
      const {vw,vh}=viewport();
      const g=ctx.createLinearGradient(0,0,vw,vh); g.addColorStop(0,PAL.bgA); g.addColorStop(1,PAL.bgB);
      ctx.fillStyle=g; ctx.fillRect(0,0,vw,vh);
      ctx.fillStyle='#ffffff'; ctx.font='bold 24px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
      ctx.fillText('Rotate your device -- landscape required', 32, 64);
      requestAnimationFrame(frame); return;
    }

    if(SCENE==='menu') renderMenu();
    else if(SCENE==='tutorial') renderTutorial();
    else if(SCENE==='level') renderLevel();
    else renderGameOver();

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();