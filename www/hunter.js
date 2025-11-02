/* HUNTER CORE r38
   - Landscape lock (rotate overlay if portrait)
   - Main menu centered + background autoplay demo
   - Title "HUNTER CORE" drop + bounce
   - Tutorial scene (back with L1/Select or tap)
   - Pathway obstacles: solid border, see-through inner lane (walkable)
   - Enemy collision hardening (multi-pass + radial push)
   - Enemies faster (baseline) and much faster when enraged
   - Stronger explosions & deep-red blood; directional death mist; bleed trails
   - On-screen-only damage (touch + explosions)
   - Damage flash; Game Over bounce then return to menu
*/

(() => {
  // ---------- Canvas ----------
  const c = document.getElementById('c') || (() => {
    const el=document.createElement('canvas'); el.id='c'; document.body.appendChild(el); return el;
  })();
  const ctx = c.getContext('2d', { alpha:false });
  const DPR = Math.max(1, Math.min(3, devicePixelRatio||1));
  function isLandscape(){ return innerWidth >= innerHeight; }
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
    bloodA:'#b60f1a', bloodB:'#6a080d', // deeper reds
    enemyBody:'#4b5a6f', enemyEdge:'#b2e2ff', enemyHead:'#d7ecff',
    enrageGlow:'#ff4a4a',
    hud:'rgba(255,255,255,0.84)',
    // solids
    solidFill:'rgba(200,220,255,0.20)',
    solidStroke:'rgba(200,220,255,0.42)',
    // ghost deco (non-solid)
    ghostFill:'rgba(255,255,255,0.07)',
    ghostStroke:'rgba(255,255,255,0.14)',
    // pathway visuals
    pathWall:'#7aa1ff', pathFloor:'rgba(180,200,255,0.08)', pathEdge:'rgba(140,180,255,0.6)',
    // Menu/UI
    title:'#e8ecff', titleEdge:'#86a2ff',
    btnFill:'#172238', btnStroke:'#88aaff', btnText:'#e8f0ff',
    cursor:'#ffd7a1', overlay:'rgba(0,0,0,0.6)',
    hurtFlash:'rgba(180,20,20,'
  };

  // ---------- Scenes ----------
  let SCENE = 'menu'; // 'menu' | 'tutorial' | 'level' | 'gameover'
  let fade = 1;      // black overlay fade
  let hurtFlash = 0; // screen flash on hurt
  let gameOverT = 0; // timer for gameover bounce

  // ---------- World ----------
  const world = {
    W: 3600, H: 2400, grid: 64, bounds: 64,
    friction: 8, accel: 1000,
    baseSpeed: 480, sprint: 1.55,  // quicker baseline
    recoilPush: 110,
    obstacles: [] // solids + ghost + pathways
  };

  // Shapes
  function rect(x,y,w,h,solid=true){ return {type:'rect',x,y,w,h,solid}; }
  function pill(x,y,r,solid=true){ return {type:'pill',x,y,r,solid}; }
  // Pathway: solid border (thickness t), walkable inner lane (visual only)
  function pathway(x,y,w,h,t=14){ return {type:'path',x,y,w,h,t,solid:true}; }

  // Layout: solids, pillars, and some pathways
  world.obstacles.push(
    rect(900,520,260,80,true), rect(1480,380,120,360,true),
    rect(2100,780,360,90,true), rect(2550,400,160,120,true),
    rect(2900,1200,220,100,true), rect(800,1400,300,90,true),
    rect(1600,1600,500,80,true), rect(2200,1840,160,380,true),
    rect(400,1900,300,120,true), rect(3000,600,90,420,true),
    pill(1200,1000,36,true), pill(1750,900,42,true), pill(2450,1350,38,true),
    pill(3100,1550,46,true), pill(600,600,32,true),
    // corridor/pathways (solid border + walkable center)
    pathway(1100,1150,420,120,16),
    pathway(2100,1200,520,120,16),
    pathway(1400,1800,480,100,16),
    // non-solid deco
    rect(1850,1120,220,40,false), pill(2600,980,28,false)
  );

  // ---------- Camera ----------
  const cam={x:0,y:0, shake:0, shx:0, shy:0, maxShake:0.6};

  // ---------- Input ----------
  const PAD={LX:0,LY:1,RX:2,RY:3,L1:4,R1:5,L2:6,R2:7,SELECT:8,START:9,L3:10,R3:11};
  const input={move:{x:0,y:0}, aim:{x:1,y:0}, fire:false, l3:false, _l1:false, _firePrev:false, select:false};
  function pad(){ const a=navigator.getGamepads?.()||[]; for(const p of a) if(p) return p; return null; }
  const dead=v=>Math.abs(v)<0.15?0:v;
  function readInput(){
    const p=pad();
    if(!p){ input.move.x=input.move.y=0; input.fire=false; input.select=false; return; }
    const lx=dead(p.axes[PAD.LX]||0), ly=dead(p.axes[PAD.LY]||0);
    const rx=dead(p.axes[PAD.RX]||0), ry=dead(p.axes[PAD.RY]||0);
    input.move.x=lx; input.move.y=ly;
    if(rx||ry){ input.aim.x=rx; input.aim.y=ry; }
    input.fire = (p.buttons[PAD.R2]?.value??0)>0.5 || !!p.buttons[PAD.R1]?.pressed;
    input.select = !!p.buttons[PAD.START]?.pressed || !!p.buttons[PAD.R1]?.pressed || ((p.buttons[PAD.R2]?.value??0)>0.5);
    input.l3   = !!p.buttons[PAD.L3]?.pressed;
    const l1   = !!p.buttons[PAD.L1]?.pressed;
    if(l1 && !input._l1 && SCENE==='level') cycleFireMode();
    input._l1 = l1;
  }
  const fireEdge = () => input.fire && !input._firePrev;

  // ---------- Player ----------
  const player = {x:world.W/2,y:world.H/2,vx:0,vy:0,r:18,ang:0,aimSmooth:0.18,hp:120,maxHp:120};

  // ---------- Enemies ----------
  const enemies=[];
  function spawnEnemy(){
    // spawn away from player
    let x,y,tries=0;
    do { x=200+Math.random()*(world.W-400); y=200+Math.random()*(world.H-400); tries++; }
    while (tries<20 && Math.hypot(x-player.x,y-player.y) < 600);
    enemies.push({
      x,y, vx:0,vy:0, w:58,h:50,r:14,
      hp:210, maxHp:210, alive:true, fade:0, deadFadeTime:0.9,
      touchPulse:16, pulseEvery:0.5, pulseTimer:0, // pulses
      state:'wander', tw:0, wx:0, wy:0, sight:620,
      enraged:false, fuse:1.4, lastHitAng:0, bleedTimer:0
    });
  }
  function ensureEnemies(max=10){
    let alive=enemies.filter(e=>e.alive).length;
    while(alive<max){ spawnEnemy(); alive++; }
  }
  ensureEnemies(10);

  // ---------- Weapon / FX ----------
  const bullets=[], sparks=[], blood=[], decals=[], mist=[];
  const weapon = {
    mode:'auto',
    rpmAuto:780, rpmSemiCap:720,
    burstSize:3, burstGap:0.07,
    shotgunPellets:7, shotgunSpread:0.13,
    semiReady:true, cd:0, muzzle:0,
    bursting:false, burstQ:0, burstT:0, burstDir:[1,0]
  };
  function cycleFireMode(){ weapon.mode=({auto:'semi',semi:'burst',burst:'shotgun',shotgun:'auto'})[weapon.mode]; }
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

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
        cam.shake = Math.min(cam.maxShake, cam.shake + 0.20); // tight
        const n=weapon.shotgunPellets, s=weapon.shotgunSpread;
        for(let i=0;i<n;i++){ const a=Math.atan2(dy,dx)+(Math.random()*2-1)*s; fireRay(Math.cos(a),Math.sin(a)); }
        weapon.cd = 0.22;
      }
    }
  }

  function spawnSparks(x,y,ang,nx=0,ny=0){
    const N=16+(Math.random()*6|0);
    for(let i=0;i<N;i++){
      const a=ang+(Math.random()*0.8-0.4), sp=320+Math.random()*320;
      sparks.push({x:x+nx*1.5,y:y+ny*1.5,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,age:0,life:0.22+Math.random()*0.25});
    }
    decals.push({type:'debris',x,y,age:0,life:5.5,rot:Math.random()*6});
  }
  function spawnBlood(x,y,ang){
    const N=18+(Math.random()*12|0);
    for(let i=0;i<N;i++){
      const a=ang+(Math.random()*1.0-0.5), sp=220+Math.random()*280;
      blood.push({x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,age:0,life:0.26+Math.random()*0.34});
    }
  }
  function spawnMist(x,y,ang){
    const N=26+(Math.random()*12|0);
    for(let i=0;i<N;i++){
      const a=ang+(Math.random()*1.2-0.6), sp=180+Math.random()*260;
      mist.push({x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,age:0,life:0.55+Math.random()*0.45});
    }
    decals.push({type:'bloodPool',x,y,age:0,life:9,rot:Math.random()*6});
  }

  // ---------- Collision helpers ----------
  function aabb(ax,ay,aw,ah,bx,by,bw,bh){ return ax<bx+bw && ax+aw>bx && ay<by+bh && ay+ah>by; }
  function circleRectPush(cx,cy,r, rx,ry,rw,rh){
    const clx=clamp(cx,rx,rx+rw), cly=clamp(cy,ry,ry+rh);
    const dx=cx-clx, dy=cy-cly, d2=dx*dx+dy*dy;
    if(d2>r*r) return null;
    const d=Math.sqrt(d2)||1, nx=dx/d, ny=dy/d;
    return {nx,ny,pen:r-d};
  }

  // For pathway collision: treat as four border rectangles
  function forEachSolid(o, fn){
    if(o.type==='path'){
      const {x,y,w,h,t}=o;
      fn({x:x,y:y,width:w,height:t});                      // top
      fn({x:x,y:y+h-t,width:w,height:t});                  // bottom
      fn({x:x,y:y+t,width:t,height:h-2*t});                // left
      fn({x:x+w-t,y:y+t,width:t,height:h-2*t});            // right
    } else if(o.type==='rect'){
      if(o.solid) fn({x:o.x,y:o.y,width:o.w,height:o.h});
    } else if(o.type==='pill'){
      // approximate pill as rect for pass (still have separate circle handler below)
      if(o.solid) fn({x:o.x-o.r,y:o.y-o.r,width:o.r*2,height:o.r*2});
    }
  }

  // ---------- Menu ----------
  const menu = {
    titleY:-160, titleVy:0, titleTarget:120, bounce:0.58, gravity:1200,
    cursor:{x:0,y:0}, // set to center on draw
    buttons:[{label:'START: LEVEL ONE', id:'start'}, {label:'INSTRUCTIONS / TUTORIAL', id:'tutorial'}]
  };

  function startLevel(){
    SCENE='level'; fade=1;
    // reset player/enemies for a clean round
    player.x=world.W/2; player.y=world.H/2; player.vx=player.vy=0; player.hp=player.maxHp=120;
    enemies.length=0; ensureEnemies(10);
  }

  // tap support
  c.addEventListener('pointerdown', (e)=>{
    const rect=c.getBoundingClientRect(); const x=(e.clientX-rect.left), y=(e.clientY-rect.top);
    if(!isLandscape()) return;
    if(SCENE==='menu'){
      const {vw,vh} = viewport();
      const btns = layoutMenu(vw,vh).btns;
      for(const b of btns){
        if(x>=b.x && x<=b.x+b.w && y>=b.y && y<=b.y+b.h){
          if(b.id==='start') startLevel(); else SCENE='tutorial';
        }
      }
      menu.cursor.x=x; menu.cursor.y=y;
    } else if(SCENE==='tutorial'){
      SCENE='menu';
    } else if(SCENE==='gameover'){
      // tap to return fast
      SCENE='menu';
    }
  });

  // ---------- Demo (menu background AI) ----------
  const demo = { t:0, px:world.W/2, py:world.H/2, ang:0 };
  function updateDemo(dt){
    demo.t += dt;
    // simple wander + shoot bursts
    const speed=120, a=demo.t*0.6;
    demo.px = clamp(demo.px + Math.cos(a)*speed*dt, world.bounds, world.W-world.bounds);
    demo.py = clamp(demo.py + Math.sin(a*1.2)*speed*dt, world.bounds, world.H-world.bounds);
    demo.ang += 0.6*dt;
  }
  function renderDemo(){
    // render like level but with fake player/enemies pathing lightly
    drawGrid();
    drawPathways();
    drawObstacles();
    // light ambient sparks/blood pools for motion hint
    ctx.globalAlpha = 0.55;
    ctx.fillStyle='#e0e8ff';
    ctx.beginPath(); ctx.arc((demo.px - cam.x), (demo.py - cam.y), 16, 0, Math.PI*2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  // ---------- Update ----------
  function viewport(){
    return {vw:c.width/DPR, vh:c.height/DPR};
  }
  function onScreen(x,y, pad=0){
    const {vw,vh} = viewport();
    return x>=cam.x-pad && x<=cam.x+vw+pad && y>=cam.y-pad && y<=cam.y+vh+pad;
  }

  function update(dt){
    readInput();

    // Landscape guard
    if(!isLandscape()){
      return; // show overlay in render()
    }

    if(SCENE==='menu'){
      // title drop
      if(menu.titleY < menu.titleTarget){
        menu.titleVy += menu.gravity*dt; menu.titleY += menu.titleVy*dt;
        if(menu.titleY > menu.titleTarget){
          menu.titleY = menu.titleTarget;
          menu.titleVy = -menu.titleVy * menu.bounce;
          if(Math.abs(menu.titleVy) < 60) menu.titleVy = 0;
        }
      }
      // menu cursor from left stick
      const {vw,vh}=viewport();
      const layout = layoutMenu(vw,vh);
      if(!menu.cursor.init){ menu.cursor.x = layout.cx; menu.cursor.y = layout.cy + 100; menu.cursor.init=true; }
      menu.cursor.x = clamp(menu.cursor.x + input.move.x*380*dt, 0, vw);
      menu.cursor.y = clamp(menu.cursor.y + input.move.y*380*dt, 0, vh);
      // background demo
      updateDemo(dt);
      // selection
      if(input.select){
        const cx=menu.cursor.x, cy=menu.cursor.y;
        for(const b of layout.btns){
          if(cx>=b.x && cx<=b.x+b.w && cy>=b.y && cy<=b.y+b.h){
            if(b.id==='start') startLevel(); else SCENE='tutorial';
          }
        }
      }
      return;
    }

    if(SCENE==='tutorial'){
      // back to menu
      if(input._l1 || pad()?.buttons[PAD.SELECT]?.pressed){ SCENE='menu'; }
      return;
    }

    if(SCENE==='gameover'){
      gameOverT += dt;
      if(gameOverT>2.2){ SCENE='menu'; }
      return;
    }

    // --- LEVEL ---
    // aim smoothing
    const targ=Math.atan2(input.aim.y,input.aim.x);
    let da=((targ-player.ang+Math.PI*3)%(Math.PI*2))-Math.PI; player.ang+=da*player.aimSmooth;

    // movement
    const im=Math.hypot(input.move.x,input.move.y); const mx=im?input.move.x/im:0, my=im?input.move.y/im:0;
    const spd=world.baseSpeed*(input.l3?world.sprint:1);
    const dvx=mx*spd, dvy=my*spd;
    player.vx+=(dvx-player.vx)*Math.min(1,dt*10);
    player.vy+=(dvy-player.vy)*Math.min(1,dt*10);
    const f=Math.exp(-world.friction*dt); player.vx*=f; player.vy*=f;
    player.x+=player.vx*dt; player.y+=player.vy*dt;

    // collisions vs solids & pathway borders
    player.x = clamp(player.x, world.bounds+player.r, world.W-world.bounds-player.r);
    player.y = clamp(player.y, world.bounds+player.r, world.H-world.bounds-player.r);

    for(const o of world.obstacles){
      if(o.type==='rect' && o.solid){
        const res=circleRectPush(player.x,player.y,player.r, o.x,o.y,o.w,o.h);
        if(res){ player.x+=res.nx*res.pen; player.y+=res.ny*res.pen; const vn=player.vx*res.nx+player.vy*res.ny; if(vn<0){ player.vx-=vn*res.nx; player.vy-=vn*res.ny; } }
      } else if(o.type==='pill' && o.solid){
        const dx=player.x-o.x, dy=player.y-o.y, rr=player.r+o.r;
        if(dx*dx+dy*dy<rr*rr){ const d=Math.hypot(dx,dy)||1, nx=dx/d, ny=dy/d; player.x=o.x+nx*rr; player.y=o.y+ny*rr; const vn=player.vx*nx+player.vy*ny; if(vn<0){ player.vx-=vn*nx; player.vy-=vn*ny; } }
      } else if(o.type==='path'){
        // collide against the four walls
        forEachSolid(o, R=>{
          const res=circleRectPush(player.x,player.y,player.r, R.x,R.y,R.width,R.height);
          if(res){ player.x+=res.nx*res.pen; player.y+=res.ny*res.pen; const vn=player.vx*res.nx+player.vy*res.ny; if(vn<0){ player.vx-=vn*res.nx; player.vy-=vn*res.ny; } }
        });
      }
    }

    // camera
    const {vw,vh} = viewport();
    cam.x = clamp(player.x - vw/2, 0, world.W-vw);
    cam.y = clamp(player.y - vh/2, 0, world.H-vh);
    cam.shake = Math.min(cam.maxShake, Math.max(0, cam.shake - dt*2.3));
    cam.shx = (Math.random()*2-1)*cam.shake*7; cam.shy = (Math.random()*2-1)*cam.shake*7;

    // weapons cadence
    const al=Math.hypot(input.aim.x,input.aim.y)||1, dx=input.aim.x/al, dy=input.aim.y/al;
    weapon.cd = Math.max(0, weapon.cd - dt);
    weapon.muzzle = Math.max(0, weapon.muzzle - dt);

    if(weapon.bursting){
      weapon.burstT -= dt;
      if(weapon.burstQ>0 && weapon.burstT<=0){
        const [bx,by]=weapon.burstDir;
        fireRay(bx,by); weapon.burstQ--; weapon.burstT = weapon.burstGap;
      }
      if(weapon.burstQ===0){ weapon.bursting=false; }
    }
    if(weapon.mode==='semi' || weapon.mode==='burst'){ if(!input.fire) weapon.semiReady=true; }

    const edge = fireEdge();
    tryShoot(dx,dy,edge);
    input._firePrev = input.fire;

    // bullets
    for (let i=bullets.length-1;i>=0;i--){
      const b=bullets[i]; b.age+=dt; b.px=b.x; b.py=b.y; b.x+=b.vx*dt; b.y+=b.vy*dt;
      let removed=false;

      // solids + path walls
      for(const o of world.obstacles){
        if(removed) break;
        if(o.type==='rect' && o.solid){
          const hit=segRectHit(b.px,b.py,b.x,b.y, o.x,o.y,o.w,o.h);
          if(hit){ spawnSparks(hit.x,hit.y, Math.atan2(b.vy,b.vx), hit.nx,hit.ny); cam.shake=Math.min(cam.maxShake, cam.shake+0.08); bullets.splice(i,1); removed=true; }
        } else if(o.type==='pill' && o.solid){
          const dx=b.x-o.x, dy=b.y-o.y, R=o.r+2, d2=dx*dx+dy*dy;
          if(d2<R*R){ const d=Math.sqrt(d2)||1, nx=dx/d, ny=dy/d; spawnSparks(o.x+nx*R,o.y+ny*R, Math.atan2(b.vy,b.vx), nx,ny); cam.shake=Math.min(cam.maxShake, cam.shake+0.08); bullets.splice(i,1); removed=true; }
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
        if(aabb(Math.min(b.x,b.px)-2,Math.min(b.y,b.py)-2, Math.abs(b.x-b.px)+4, Math.abs(b.y-b.py)+4, e.x-e.w/2, e.y-e.h/2, e.w, e.h)){
          if(aabb(b.x-2,b.y-2,4,4, e.x-e.w/2, e.y-e.h/2, e.w, e.h)){
            e.hp = Math.max(0, e.hp - 14);
            e.vx += b.vx*0.02; e.vy += b.vy*0.02;
            const ang = Math.atan2(b.vy,b.vx); e.lastHitAng = ang; spawnBlood(b.x,b.y, ang);
            cam.shake = Math.min(cam.maxShake, cam.shake + 0.06);
            e.bleedTimer = 0.1;
            if(!e.enraged && e.hp <= e.maxHp*0.38){ e.enraged=true; e.fuse=1.2; } // earlier, faster
            if(e.hp===0 && e.alive){ e.alive=false; e.fade=0; spawnMist(e.x,e.y, e.lastHitAng); }
            bullets.splice(i,1); removed=true; break;
          }
        }
      }

      // bounds → sparks
      if(!removed && (b.x<world.bounds || b.x>world.W-world.bounds || b.y<world.bounds || b.y>world.H-world.bounds)){
        let nx=0,ny=0; if(b.x<world.bounds) nx=1; else if(b.x>world.W-world.bounds) nx=-1; if(b.y<world.bounds) ny=1; else if(b.y>world.H-world.bounds) ny=-1;
        spawnSparks(b.x,b.y, Math.atan2(b.vy,b.vx), nx,ny); bullets.splice(i,1);
      }
      if(!removed && b.age>b.life){ bullets.splice(i,1); }
    }

    // enemies AI / collisions / pulses / enrage
    for(const e of enemies){
      if(!e.alive){ e.fade+=dt; continue; }

      // brain
      const dxp=player.x-e.x, dyp=player.y-e.y, dist=Math.hypot(dxp,dyp)||1, ux=dxp/dist, uy=dyp/dist;
      if(dist<e.sight || cam.shake>0.35) e.state='chase';
      const healthFrac = e.hp / e.maxHp;
      const base = 170 + (1 - healthFrac) * 90; // faster baseline + scales with damage
      const bonus = e.enraged ? 110 : 0;        // big speed-up when enraged
      const targetSpeed = base + bonus;

      if(e.state==='wander'){
        e.tw -= dt; if(e.tw<=0){ const a=Math.random()*Math.PI*2, m=110+Math.random()*140; e.wx=Math.cos(a)*m; e.wy=Math.sin(a)*m; e.tw=0.8+Math.random()*1.2; }
        e.vx += (e.wx-e.vx)*Math.min(1,dt*2.1); e.vy += (e.wy-e.vy)*Math.min(1,dt*2.1);
      } else {
        e.vx += (ux*targetSpeed - e.vx)*Math.min(1,dt*3.0);
        e.vy += (uy*targetSpeed - e.vy)*Math.min(1,dt*3.0);
      }
      const ef=Math.exp(-11*dt); e.vx*=ef; e.vy*=ef; e.x+=e.vx*dt; e.y+=e.vy*dt;

      // strict resolution against solids & path walls (more passes + radial push)
      for(let pass=0; pass<5; pass++){
        for(const o of world.obstacles){
          if(o.type==='rect' && o.solid){
            if(aabb(e.x-e.w/2,e.y-e.h/2,e.w,e.h, o.x,o.y,o.w,o.h)){
              const left=(e.x-(e.w/2))-o.x, right=(o.x+o.w)-(e.x+(e.w/2));
              const top=(e.y-(e.h/2))-o.y, bottom=(o.y+o.h)-(e.y+(e.h/2));
              const minX=Math.min(Math.abs(left),Math.abs(right));
              const minY=Math.min(Math.abs(top),Math.abs(bottom));
              if(minX<minY){ e.x += (Math.abs(left)<Math.abs(right)? -left : right); e.vx=0; }
              else { e.y += (Math.abs(top)<Math.abs(bottom)? -top : bottom); e.vy=0; }
            }
          } else if(o.type==='pill' && o.solid){
            const dx=e.x-o.x, dy=e.y-o.y, rr=Math.max(e.w,e.h)/2+o.r;
            if(dx*dx+dy*dy<rr*rr){ const d=Math.hypot(dx,dy)||1, nx=dx/d, ny=dy/d; e.x=o.x+nx*rr; e.y=o.y+ny*rr; const vn=e.vx*nx+e.vy*ny; if(vn<0){ e.vx-=vn*nx; e.vy-=vn*ny; } }
          } else if(o.type==='path'){
            forEachSolid(o, R=>{
              if(aabb(e.x-e.w/2,e.y-e.h/2,e.w,e.h, R.x,R.y,R.width,R.height)){
                const left=(e.x-(e.w/2))-R.x, right=(R.x+R.width)-(e.x+(e.w/2));
                const top=(e.y-(e.h/2))-R.y, bottom=(R.y+R.height)-(e.y+(e.h/2));
                const minX=Math.min(Math.abs(left),Math.abs(right));
                const minY=Math.min(Math.abs(top),Math.abs(bottom));
                if(minX<minY){ e.x += (Math.abs(left)<Math.abs(right)? -left : right); e.vx=0; }
                else { e.y += (Math.abs(top)<Math.abs(bottom)? -top : bottom); e.vy=0; }
              }
            });
          }
        }
      }

      // vs player -> pulse damage ONLY if on-screen
      const px=e.x-player.x, py=e.y-player.y, pr=player.r+Math.max(e.w,e.h)/2-6;
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

      // bleed trail while hurt
      e.bleedTimer -= dt;
      if(e.hp<e.maxHp && e.bleedTimer<=0){
        e.bleedTimer = 0.10 + Math.random()*0.14;
        decals.push({type:'droplet',x:e.x,y:e.y,age:0,life:2.8,rot:Math.random()*6});
      }

      // enrage fuse / explosion (damage only if on-screen)
      if(e.enraged){
        e.fuse -= dt;
        if(e.fuse<=0){
          const ex=e.x, ey=e.y; cam.shake=Math.min(cam.maxShake, cam.shake+0.55);
          spawnMist(ex,ey, e.lastHitAng);
          if(onScreen(ex,ey)){
            const kx=player.x-ex, ky=player.y-ey, dd=Math.hypot(kx,ky)||1, fall=Math.max(0,1-dd/260);
            player.vx += (kx/dd)*290*fall; player.vy += (ky/dd)*290*fall;
            player.hp = Math.max(0, player.hp - 38*fall); hurtFlash = 0.4;
          }
          e.alive=false; e.fade=0;
        }
      }
    }

    // cull / maintain enemy count
    for(let i=enemies.length-1;i>=0;i--){
      const e=enemies[i];
      if(!e.alive && e.fade>e.deadFadeTime){ enemies.splice(i,1); }
    }
    ensureEnemies(10);

    // effects lifetimes
    for(let i=sparks.length-1;i>=0;i--){ const s=sparks[i]; s.age+=dt; s.vx*=0.98; s.vy=s.vy*0.98+600*dt*0.18; s.x+=s.vx*dt; s.y+=s.vy*dt; if(s.age>s.life) sparks.splice(i,1); }
    for(let i=blood.length-1;i>=0;i--){ const b=blood[i]; b.age+=dt; b.vx*=0.98; b.vy=b.vy*0.98+600*dt*0.22; b.x+=b.vx*dt; b.y+=b.vy*dt; if(b.age>b.life) blood.splice(i,1); }
    for(let i=mist.length-1;i>=0;i--){ const m=mist[i]; m.age+=dt; m.vx*=0.97; m.vy=m.vy*0.97+600*dt*0.12; m.x+=m.vx*dt; m.y+=m.vy*dt; if(m.age>m.life) mist.splice(i,1); }
    for(let i=decals.length-1;i>=0;i--){ const d=decals[i]; d.age+=dt; if(d.age>d.life) decals.splice(i,1); }

    // Player hurt flash decay & death
    if(hurtFlash>0) hurtFlash = Math.max(0, hurtFlash - dt*1.8);
    if(player.hp<=0 && SCENE==='level'){
      SCENE='gameover'; gameOverT=0;
    }

    // fade-in after start
    if(fade>0){ fade=Math.max(0, fade - dt*1.2); }
  }

  // ---------- Render helpers ----------
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
    // visual for path corridors: walls & inner lane
    for(const o of world.obstacles){
      if(o.type!=='path') continue;
      const ix=o.x+o.t, iy=o.y+o.t, iw=o.w-2*o.t, ih=o.h-2*o.t;
      // outer wall
      ctx.fillStyle=PAL.solidFill; ctx.strokeStyle=PAL.solidStroke; ctx.lineWidth=1.6;
      ctx.fillRect(o.x-cam.x+cam.shx, o.y-cam.y+cam.shy, o.w, o.h);
      ctx.strokeRect(o.x-cam.x+cam.shx, o.y-cam.y+cam.shy, o.w, o.h);
      // inner walkable lane
      ctx.fillStyle=PAL.pathFloor; ctx.strokeStyle=PAL.pathEdge; ctx.lineWidth=1.2;
      ctx.fillRect(ix-cam.x+cam.shx, iy-cam.y+cam.shy, iw, ih);
      ctx.strokeRect(ix-cam.x+cam.shx, iy-cam.y+cam.shy, iw, ih);
    }
  }

  function drawObstacles(){
    ctx.lineWidth=1.6;
    for(const o of world.obstacles){
      if(o.type==='path') continue; // drawn by drawPathways
      if(o.type==='rect'){
        const f = o.solid ? PAL.solidFill : PAL.ghostFill;
        const s = o.solid ? PAL.solidStroke: PAL.ghostStroke;
        ctx.fillStyle=f; ctx.strokeStyle=s;
        ctx.fillRect(o.x-cam.x+cam.shx, o.y-cam.y+cam.shy, o.w, o.h);
        ctx.strokeRect(o.x-cam.x+cam.shx, o.y-cam.y+cam.shy, o.w, o.h);
      } else {
        const f = o.solid ? PAL.solidFill : PAL.ghostFill;
        const s = o.solid ? PAL.solidStroke: PAL.ghostStroke;
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
      else if(d.type==='droplet'){ ctx.fillStyle=`rgba(170,18,28,${0.38*k})`; ctx.beginPath(); ctx.ellipse(0,0,4,2,0,0,Math.PI*2); ctx.fill(); }
      ctx.restore();
    }
  }

  function drawEnemies(){
    for(const e of enemies){
      if(!e.alive) continue;
      const x=e.x-cam.x+cam.shx, y=e.y-cam.y+cam.shy, r=10, w=e.w, h=e.h;
      let bodyFill = e.enraged ? `rgba(255,74,74,${0.5 + 0.35*((Math.sin(performance.now()/90)+1)/2)})` : PAL.enemyBody;
      ctx.fillStyle=bodyFill; ctx.strokeStyle=PAL.enemyEdge; ctx.lineWidth=2;
      ctx.beginPath();
      ctx.moveTo(x-w/2+r, y-h/2);
      ctx.arcTo(x+w/2, y-h/2, x+w/2, y+h/2, r);
      ctx.arcTo(x+w/2, y+h/2, x-w/2, y+h/2, r);
      ctx.arcTo(x-w/2, y+h/2, x-w/2, y-h/2, r);
      ctx.arcTo(x-w/2, y-h/2, x+w/2, y-h/2, r);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      // head
      ctx.beginPath(); ctx.arc(x, y-h*0.35, e.r, 0, Math.PI*2); ctx.fillStyle=PAL.enemyHead; ctx.fill();
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
    for(const b of blood){
      const r=2.6*(1-b.age/b.life);
      ctx.fillStyle = b.age < b.life*0.5 ? PAL.bloodA : PAL.bloodB;
      ctx.beginPath(); ctx.arc(b.x-cam.x+cam.shx, b.y-cam.y+cam.shy, Math.max(0,r), 0, Math.PI*2); ctx.fill();
    }
    for(const m of mist){
      const r=4.2*(1-m.age/m.life);
      ctx.fillStyle = `rgba(150,15,25,${0.38*(1-m.age/m.life)})`;
      ctx.beginPath(); ctx.arc(m.x-cam.x+cam.shx, m.y-cam.y+cam.shy, Math.max(0,r), 0, Math.PI*2); ctx.fill();
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
    if(SCENE==='level'){
      ctx.fillText(`Mode: ${weapon.mode.toUpperCase()} (L1)`, 16, 22);
      ctx.fillText(`Sprint: L3`, 16, 40);
      ctx.fillText(`HP: ${Math.ceil(player.hp)}/${player.maxHp}`, 16, 58);
      if(fade>0){ ctx.fillStyle=`rgba(0,0,0,${fade})`; ctx.fillRect(0,0,c.width/DPR,c.height/DPR); }
      if(hurtFlash>0){ ctx.fillStyle=PAL.hurtFlash + (0.5*hurtFlash) + ')'; ctx.fillRect(0,0,c.width/DPR,c.height/DPR); }
    }
  }

  // ----- Menu/Tutorial/GameOver Renders -----
  function layoutMenu(vw,vh){
    const titleY = menu.titleY;
    const cx = vw/2, cy = vh/2;
    const btnW = 340, btnH = 50, gap = 14;
    const b1 = {x: cx-btnW/2, y: cy+40, w: btnW, h: btnH, id:'start', label:'START: LEVEL ONE'};
    const b2 = {x: cx-btnW/2, y: cy+40 + btnH + gap, w: btnW, h: btnH, id:'tutorial', label:'INSTRUCTIONS / TUTORIAL'};
    return {cx, cy, titleY, btns:[b1,b2]};
  }

  function renderMenu(){
    const {vw,vh}=viewport();
    // bg demo
    // keep camera centered so demo looks good
    cam.x = clamp(demo.px - vw/2, 0, world.W-vw);
    cam.y = clamp(demo.py - vh/2, 0, world.H-vh);
    renderDemo();

    // darken for contrast
    ctx.fillStyle='rgba(0,0,0,0.45)'; ctx.fillRect(0,0,vw,vh);

    // centered title
    ctx.save();
    ctx.translate(vw/2, menu.titleY);
    ctx.font='bold 48px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    ctx.fillStyle=PAL.title; ctx.strokeStyle=PAL.titleEdge; ctx.lineWidth=3;
    const txt='HUNTER CORE';
    const m=ctx.measureText(txt);
    ctx.strokeText(txt, -m.width/2, 0);
    ctx.fillText(txt, -m.width/2, 0);
    ctx.restore();

    // buttons centered
    const L=layoutMenu(vw,vh);
    for(const b of L.btns){
      ctx.fillStyle=PAL.btnFill; ctx.strokeStyle=PAL.btnStroke; ctx.lineWidth=2;
      ctx.fillRect(b.x, b.y, b.w, b.h); ctx.strokeRect(b.x,b.y,b.w,b.h);
      ctx.fillStyle=PAL.btnText; ctx.font='16px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
      const mt=ctx.measureText(b.label);
      ctx.fillText(b.label, b.x + (b.w-mt.width)/2, b.y + 32);
    }

    // cursor (left stick)
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
    const lines = [
      'Move: Left Stick (L3 = Sprint)',
      'Aim: Right Stick',
      'Fire: R2 / R1',
      'Toggle Fire Mode: L1 (AUTO / SEMI / BURST / SHOTGUN)',
      'Zombies: Hurt on contact (pulses), bleed when injured, enrage & explode at low HP.',
      'Walls & Pathways: Opaque = solid. Pathways show solid borders with a see-through lane.',
      'Goal: Survive. Damage only applies from threats visible on your screen.',
      'Press L1 / SELECT or tap to go back.'
    ];
    let y=110; for(const ln of lines){ ctx.fillText(ln, 40, y); y+=26; }
  }

  function renderLevel(){
    drawGrid(); drawPathways(); drawObstacles(); drawDecals(); drawEnemies(); drawFX(); drawBullets(); drawPlayer(); drawHUD();
  }

  function renderGameOver(){
    const {vw,vh}=viewport();
    // freeze frame darken
    ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(0,0,vw,vh);
    // bounce scale
    const t=gameOverT;
    const s = 1 + 0.12*Math.sin(Math.min(1,t)*Math.PI); // quick bounce
    ctx.save(); ctx.translate(vw/2, vh/2); ctx.scale(s,s);
    ctx.font='bold 52px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    ctx.fillStyle=PAL.title; ctx.strokeStyle=PAL.titleEdge; ctx.lineWidth=4;
    const txt='GAME OVER';
    const m=ctx.measureText(txt);
    ctx.strokeText(txt, -m.width/2, 0);
    ctx.fillText(txt, -m.width/2, 0);
    ctx.restore();
  }

  // segment-rect intersection (for bullet surface hits)
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

  // ---------- Main ----------
  function frame(now){
    const dt=Math.min(0.033, ((now-(frame.t||now))/1000)); frame.t=now;
    update(dt);

    if(!isLandscape()){
      // rotate prompt
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