/* HUNTER-CORE r19 -- cohesive drop-in
   - collide & slide vs solids
   - directional blood, wall sparks
   - enemy tiers + corpse fade + respawn cap
   - gamepad: A/Cross confirms in menu, L1 mode, L3 sprint, R2 fire
*/
(() => {
  // ---------- Canvas / Camera ----------
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d', { alpha:false });
  const DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  let W=0,H=0, VW=0, VH=0;

  function resize(){
    W = innerWidth; H = innerHeight;
    canvas.width = W * DPR; canvas.height = H * DPR;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(DPR,0,0,DPR,0,0);
    VW=W; VH=H;
  }
  addEventListener('resize', resize);
  resize();

  const cam = {
    x:0, y:0, shakeAmt:0,
    apply(){
      if (this.shakeAmt>0){
        const s = this.shakeAmt;
        this.shakeAmt *= 0.90;
        ctx.translate((Math.random()*2-1)*8*s, (Math.random()*2-1)*8*s);
      }
      ctx.translate(Math.floor(VW*0.5 - this.x), Math.floor(VH*0.5 - this.y));
    },
    begin(){ ctx.save(); this.apply(); },
    end(){ ctx.restore(); },
    shake(a){ this.shakeAmt = Math.min(0.5, this.shakeAmt + a); }
  };

  // ---------- RNG helpers ----------
  const rand=(a,b)=>a+Math.random()*(b-a);
  const pick=a=>a[(Math.random()*a.length)|0];

  // ---------- Input ----------
  const input = {
    pad: null, // first connected
    lx:0, ly:0, rx:0, ry:0,
    L1:false, L3:false, R2:false, A:false,
    anyConfirm:false,
    update() {
      const pads = navigator.getGamepads?.()||[];
      this.pad = pads.find(p=>p && p.connected) || null;
      if (this.pad){
        const p=this.pad, b=p.buttons, ax=p.axes;
        this.lx = ax[0]||0; this.ly = ax[1]||0;
        this.rx = ax[2]||0; this.ry = ax[3]||0;
        this.L1 = !!b[4]?.pressed;
        this.L3 = !!b[10]?.pressed; // LS
        this.R2 = (b[7]?.pressed)||false;
        this.A  = !!b[0]?.pressed;  // Cross/A
      } else {
        // keyboard fallback
        this.lx = (keys['ArrowRight']||keys['KeyD']?1:0) - (keys['ArrowLeft']||keys['KeyA']?1:0);
        this.ly = (keys['ArrowDown']||keys['KeyS']?1:0) - (keys['ArrowUp']||keys['KeyW']?1:0);
        this.rx = mouseAim.x - player.x;
        this.ry = mouseAim.y - player.y;
        const len = Math.hypot(this.rx, this.ry)||1;
        this.rx/=len; this.ry/=len;
        this.L1 = keys['KeyQ'];
        this.L3 = keys['ShiftLeft']||keys['ShiftRight'];
        this.R2 = mouseDown || keys['Space'];
        this.A  = keys['Enter'];
      }
      this.anyConfirm = !!this.A;
    }
  };
  const keys={}; addEventListener('keydown',e=>keys[e.code]=true);
  addEventListener('keyup',e=>keys[e.code]=false);

  const mouseAim={x:0,y:0}; let mouseDown=false;
  canvas.addEventListener('mousemove',e=>{
    const rect = canvas.getBoundingClientRect();
    mouseAim.x = cam.x - VW*0.5 + (e.clientX-rect.left);
    mouseAim.y = cam.y - VH*0.5 + (e.clientY-rect.top);
  });
  canvas.addEventListener('mousedown',()=>mouseDown=true);
  addEventListener('mouseup',()=>mouseDown=false);

  // ---------- World ----------
  const world = {
    grid: 64,
    solids: [],
    spawnMap(){
      // simple tasteful blocks + lanes (replace with your authored map later)
      this.solids = [
        R( 500, 300, 520, 70),
        R( 980, 300, 120, 70),
        R(1300, 520, 120, 260),
        R( 820, 540, 120, 120),
        R( 620, 520, 260, 120),
      ];
    }
  };
  function R(x,y,w,h){ return {x:x,y:y,w:w,h:h}; } // center-x/y rect

  // ---------- Player ----------
  const player = {
    x:800, y:420, vx:0, vy:0, r:18,
    accel:0.9, friction:0.85,
    baseSpeed:2.6, sprintSpeed:4.1,
    hp:120, hpMax:120,
    aim:0, mode:0, // 0=AUTO 1=BURST 2=SEMI 3=SHOTGUN
    canShootSemi:true, burstTimer:0, burstLeft:0,
  };

  const MODES = ['AUTO','BURST','SEMI','SHOTGUN'];

  // ---------- Enemies ----------
  const ENEMY = {
    base: 1.35,
    notice: 1.9,
    frenzy: 2.6,
    frenzyHPFrac: 0.35,
    maxAlive: 10,
    spawnRadius: 900,
  };
  const enemies = [];

  function makeEnemy() {
    // simple silhouette body (reads better than a square)
    const ang = rand(0,Math.PI*2);
    const dist = ENEMY.spawnRadius;
    const e = {
      x: player.x + Math.cos(ang)*dist,
      y: player.y + Math.sin(ang)*dist,
      vx:0, vy:0, r:16,
      hp: 85, maxhp: 85,
      dead:false, fade:0, lastHitDir:0,
    };
    return e;
  }

  function enemySpeedFor(e){
    const d2 = (e.x-player.x)**2 + (e.y-player.y)**2;
    const sees = d2 < 700*700;
    if (e.hp/e.maxhp <= ENEMY.frenzyHPFrac) return ENEMY.frenzy;
    return sees ? ENEMY.notice : ENEMY.base;
  }

  // ---------- Bullets & Particles ----------
  const bullets = [];
  const particles = [];

  const FX = {
    blood: {
      onHit:   { count: 10,  size: [2,4],  life:[220,420], speed:[2.0,5.0] },
      onDeath: { count: 60,  size: [3,7],  life:[360,720], speed:[3.5,9.0] },
      colorStops: ["#a10d12","#be1218","#e51d23","#6b0a0d"]
    },
    sparks: { count: 14, size:[1.5,3], life:[120,260], speed:[3,7], color:"#c8d4ff" },
    shake: { hit: 0.12, kill: 0.28, shotgun: 0.22 }
  };

  function spawnBlood(x,y,dir,pack) {
    for (let i=0;i<pack.count;i++){
      const ang = dir + rand(-0.6, 0.6);
      const spd = rand(pack.speed[0], pack.speed[1]);
      particles.push({
        x,y, vx:Math.cos(ang)*spd, vy:Math.sin(ang)*spd,
        r: rand(pack.size[0], pack.size[1]),
        t: rand(pack.life[0], pack.life[1]),
        col: pick(FX.blood.colorStops),
        type:'blood', g:0.08, drag:0.985
      });
    }
  }
  function spawnSparks(x,y,nx,ny){
    const base = Math.atan2(ny, nx) + Math.PI;
    for (let i=0;i<FX.sparks.count;i++){
      const ang = base + rand(-Math.PI/6, Math.PI/6);
      const spd = rand(FX.sparks.speed[0], FX.sparks.speed[1]);
      particles.push({
        x,y, vx:Math.cos(ang)*spd, vy:Math.sin(ang)*spd,
        r: rand(FX.sparks.size[0], FX.sparks.size[1]),
        t: rand(FX.sparks.life[0], FX.sparks.life[1]),
        col: FX.sparks.color, type:'spark', g:0, drag:0.94
      });
    }
  }

  // ---------- Collision (circle vs rect) ----------
  function resolveCircleRect(circle, rect) {
    const rx = rect.x - rect.w*0.5, ry = rect.y - rect.h*0.5;
    const cx = Math.max(rx, Math.min(circle.x, rx + rect.w));
    const cy = Math.max(ry, Math.min(circle.y, ry + rect.h));
    const dx = circle.x - cx, dy = circle.y - cy;
    const d2 = dx*dx + dy*dy, r = circle.r;
    if (d2 < r*r) {
      const d = Math.max(0.0001, Math.sqrt(d2));
      const push = (r - d);
      const nx = dx/d, ny = dy/d;
      return { hit:true, nx, ny, push, cx, cy };
    }
    return { hit:false };
  }
  function collideAndSlide(m, solids) {
    m.x += m.vx; m.y += m.vy;
    for (let it=0; it<2; it++) {
      let any=false;
      for (const s of solids) {
        const res = resolveCircleRect({x:m.x,y:m.y,r:m.r}, s);
        if (res.hit) {
          m.x += res.nx * res.push;
          m.y += res.ny * res.push;
          const vn = m.vx*res.nx + m.vy*res.ny;
          if (vn>0){ m.vx -= vn*res.nx; m.vy -= vn*res.ny; }
          any=true;
        }
      }
      if (!any) break;
    }
  }

  // ---------- Shooting ----------
  function fireBullet(dir, speed, dmg, spread=0, life=520){
    const ang = dir + rand(-spread, spread);
    bullets.push({
      x: player.x + Math.cos(player.aim)*player.r*1.2,
      y: player.y + Math.sin(player.aim)*player.r*1.2,
      vx: Math.cos(ang)*speed,
      vy: Math.sin(ang)*speed,
      ttl: life,
      r: 3,
      damage: dmg,
      dir: ang,
      dead:false
    });
  }

  function handleShooting(dt){
    const shooting = input.R2;
    // mode toggle (debounce)
    if (!handleShooting._l1Prev && input.L1){
      player.mode = (player.mode+1) % MODES.length;
    }
    handleShooting._l1Prev = input.L1;

    const FIRE = {
      AUTO:     { rate: 7, speed: 11, dmg: 20, spread:0.02 },
      BURST:    { rate: 8, speed: 11, dmg: 16, spread:0.03, size:3, gap:3 },
      SEMI:     { rate: 9, speed: 12, dmg: 28, spread:0.01 },
      SHOTGUN:  { rate:16, speed: 13, dmg: 12, spread:0.22, pellets:6 }
    };

    handleShooting.cool = (handleShooting.cool||0)-dt;
    if (handleShooting.cool>0) return;

    switch (player.mode){
      case 0: { // AUTO
        if (shooting){
          const P=FIRE.AUTO;
          fireBullet(player.aim,P.speed,P.dmg,P.spread,380);
          cam.shake(0.08);
          handleShooting.cool = P.rate;
        }
      } break;
      case 1: { // BURST (cannot outpace AUTO anymore)
        const P=FIRE.BURST;
        if (shooting && player.burstLeft<=0){
          player.burstLeft=P.size;
          player.burstTimer=0;
        }
        if (player.burstLeft>0){
          if (player.burstTimer<=0){
            fireBullet(player.aim,P.speed,P.dmg,P.spread,380);
            cam.shake(0.07);
            player.burstLeft--;
            player.burstTimer=P.gap;
          } else player.burstTimer-=dt;
          handleShooting.cool = P.rate;
        }
      } break;
      case 2: { // SEMI
        if (shooting && player.canShootSemi){
          const P=FIRE.SEMI;
          fireBullet(player.aim,P.speed,P.dmg,P.spread,420);
          cam.shake(0.09);
          player.canShootSemi=false;
          handleShooting.cool = P.rate;
        }
        if (!shooting) player.canShootSemi=true;
      } break;
      case 3: { // SHOTGUN
        if (shooting){
          const P=FIRE.SHOTGUN;
          for (let i=0;i<P.pellets;i++)
            fireBullet(player.aim,P.speed,P.dmg,P.spread,300);
          cam.shake(FX.shake.shotgun);
          handleShooting.cool = P.rate;
        }
      } break;
    }
  }

  // ---------- Bullet vs World / Enemies ----------
  function bulletHitsSolid(b){
    for (const s of world.solids){
      const res = resolveCircleRect({x:b.x,y:b.y,r:b.r}, s);
      if (res.hit){
        spawnSparks(res.cx, res.cy, res.nx, res.ny);
        b.dead=true; return true;
      }
    }
    return false;
  }

  function bulletHitsEnemy(b){
    for (const e of enemies){
      if (e.dead) continue;
      const dx=e.x-b.x, dy=e.y-b.y;
      const d2=dx*dx+dy*dy, rr=(e.r+b.r)*(e.r+b.r);
      if (d2<=rr){
        e.hp -= b.damage;
        e.lastHitDir = b.dir;
        spawnBlood(b.x,b.y,b.dir, FX.blood.onHit);
        cam.shake(FX.shake.hit);
        b.dead=true;
        if (e.hp<=0){
          e.dead=true; e.fade=1;
          spawnBlood(e.x,e.y,e.lastHitDir||b.dir, FX.blood.onDeath);
          cam.shake(FX.shake.kill);
        }
        return true;
      }
    }
    return false;
  }

  // ---------- Particles update ----------
  function updateParticles(){
    for (let i=particles.length-1;i>=0;i--){
      const p=particles[i];
      p.vx*=p.drag; p.vy*=p.drag;
      p.vy+=p.g||0;
      p.x+=p.vx; p.y+=p.vy;
      if ((p.t-=1)<=0) particles.splice(i,1);
    }
  }

  // ---------- Menu ----------
  let state = 'menu';
  const menu = {
    t:0, idx:0, options:['START','TUTORIAL'],
    update(){
      this.t++;
      // simple stick cursor
      if (!menu._moveCd) {
        if (input.ly<-0.4) { this.idx=(this.idx+this.options.length-1)%this.options.length; menu._moveCd=12; }
        if (input.ly> 0.4) { this.idx=(this.idx+1)%this.options.length; menu._moveCd=12; }
      } else menu._moveCd--;
      // confirm with A/Cross
      if (input.anyConfirm){
        if (this.options[this.idx]==='START') startGame();
        else showTutorial();
      }
    },
    draw(){
      ctx.fillStyle='#0f1620'; ctx.fillRect(0,0,VW,VH);
      // faint demo camera pan
      const px = player.x + Math.cos(this.t*0.01)*120;
      const py = player.y + Math.sin(this.t*0.013)*90;
      cam.x = px; cam.y = py;

      cam.begin();
      drawWorld();
      drawHUD(true);
      cam.end();

      // title
      ctx.fillStyle='#e5ecff';
      ctx.font='bold 42px system-ui, -apple-system, Segoe UI, Roboto';
      ctx.textAlign='center';
      ctx.fillText('HUNTER-CORE', VW*0.5, 120);
      // menu items
      ctx.font='24px system-ui';
      this.options.forEach((o,i)=>{
        const y = 200 + i*42;
        const sel = (i===this.idx);
        ctx.fillStyle = sel ? '#9cc0ff' : '#cbd6f7';
        ctx.fillText((sel?'> ':'') + o, VW*0.5, y);
      });
      // tiny hint
      ctx.fillStyle='#8090a8';
      ctx.font='14px system-ui';
      ctx.fillText('A / Cross to select • L-Stick to move', VW*0.5, VH-28);
    }
  };
  function startGame(){ state='game'; }
  function showTutorial(){
    alert('Move: LS • Aim: RS • Fire: R2 • Sprint: L3 • Switch Fire Mode: L1');
  }

  // ---------- Game loop ----------
  let lt=0;
  function loop(t){
    requestAnimationFrame(loop);
    const now = t|0; const dt = Math.min(20, now-lt||16); lt=now;

    input.update();

    if (state==='menu'){
      menu.update();
      menu.draw();
      return;
    }

    update(dt);
    draw();
  }

  // ---------- Update ----------
  function update(dt){
    // player aim from RS
    if (Math.hypot(input.rx,input.ry)>0.2){
      const desired = Math.atan2(input.ry, input.rx);
      // smooth aim
      let da = ((desired - player.aim + Math.PI*3)%(Math.PI*2))-Math.PI;
      player.aim += da * 0.25;
    }
    // movement
    const speed = (input.L3?player.sprintSpeed:player.baseSpeed);
    player.vx = player.vx*player.friction + input.lx*player.accel;
    player.vy = player.vy*player.friction + input.ly*player.accel;

    // clamp to speed
    const m = Math.hypot(player.vx,player.vy);
    const max = speed;
    if (m>max){ player.vx=player.vx/m*max; player.vy=player.vy/m*max; }

    collideAndSlide(player, world.solids);

    // camera center
    cam.x = player.x; cam.y = player.y;

    // shooting
    handleShooting(dt);

    // bullets
    for (let i=bullets.length-1;i>=0;i--){
      const b=bullets[i];
      b.x += b.vx; b.y += b.vy;
      b.ttl--;
      if (bulletHitsSolid(b) || bulletHitsEnemy(b)) { /* handled */ }
      if (b.ttl<=0 || b.dead) bullets.splice(i,1);
    }

    // enemies AI
    // keep population
    const alive = enemies.filter(e=>!e.remove && !e.dead).length;
    if (alive < ENEMY.maxAlive){
      for (let i=0;i<ENEMY.maxAlive-alive;i++) enemies.push(makeEnemy());
    }

    for (let i=enemies.length-1;i>=0;i--){
      const e=enemies[i];
      if (e.remove){ enemies.splice(i,1); continue; }

      if (e.dead){
        e.fade -= 0.05;
        if (e.fade<=0) e.remove=true;
        continue;
      }

      // target player
      const ang = Math.atan2(player.y-e.y, player.x-e.x);
      const spd = enemySpeedFor(e);
      e.vx = Math.cos(ang)*spd;
      e.vy = Math.sin(ang)*spd;

      collideAndSlide(e, world.solids);

      // contact damage in pulses (visible-only rule later if you want)
      const d2=(e.x-player.x)**2+(e.y-player.y)**2;
      const rr=(e.r+player.r)*(e.r+player.r);
      if (d2<rr){
        // pulse: every ~300ms
        if (!e._pulse || e._pulse<=0){
          player.hp = Math.max(0, player.hp-10);
          cam.shake(0.1);
          e._pulse = 18; // frames
        } else e._pulse--;
      } else e._pulse=0;
    }

    // particles
    updateParticles();

    // death -> return to menu
    if (player.hp<=0){
      // quick game over bounce in menu path:
      alert('GAME OVER');
      // reset quick
      resetGame();
      state='menu';
    }
  }

  function resetGame(){
    bullets.length=0; particles.length=0; enemies.length=0;
    player.x=800; player.y=420; player.vx=player.vy=0;
    player.hp=player.hpMax; player.mode=0; player.canShootSemi=true;
  }

  // ---------- Draw ----------
  function drawWorld(){
    // checker floor
    const g = world.grid;
    for (let y=-2; y<=Math.ceil(VH/g)+2; y++){
      for (let x=-2; x<=Math.ceil(VW/g)+2; x++){
        const wx = (Math.floor((cam.x - VW*0.5)/g)+x)*g;
        const wy = (Math.floor((cam.y - VH*0.5)/g)+y)*g;
        const i = ((x+y)&1);
        ctx.fillStyle = i? '#121b26' : '#0f1620';
        ctx.fillRect(wx,wy,g,g);
      }
    }
    // solids
    ctx.lineWidth=2;
    for (const s of world.solids){
      ctx.fillStyle='rgba(180,195,220,0.08)';
      ctx.strokeStyle='rgba(190,205,235,0.35)';
      ctx.beginPath();
      ctx.rect(s.x-s.w*0.5, s.y-s.h*0.5, s.w, s.h);
      ctx.fill(); ctx.stroke();
    }

    // bullets
    ctx.fillStyle='#cbd6ff';
    for (const b of bullets){
      ctx.beginPath(); ctx.arc(b.x,b.y,b.r,0,Math.PI*2); ctx.fill();
    }

    // enemies
    for (const e of enemies){
      if (e.dead){
        ctx.globalAlpha=Math.max(0,e.fade);
        ctx.fillStyle='#2a0b10';
        ctx.beginPath(); ctx.arc(e.x,e.y,e.r*0.9,0,Math.PI*2); ctx.fill();
        ctx.globalAlpha=1;
        continue;
      }
      // simple silhouette: torso + head + tiny shoulder
      ctx.fillStyle='#b9deff';
      ctx.strokeStyle='#92c2ff';
      ctx.lineWidth=3;
      // torso (rounded square)
      const r=e.r, t=r*1.2;
      roundRect(e.x-t*0.6, e.y-t*0.6, t, t, 10, true, true);
      // head
      ctx.beginPath(); ctx.arc(e.x, e.y-t*0.75, r*0.75, 0, Math.PI*2); ctx.fill(); ctx.stroke();
      // hp bar
      const frac = Math.max(0,e.hp/e.maxhp);
      ctx.strokeStyle='#e37a7a'; ctx.lineWidth=4;
      ctx.beginPath(); ctx.moveTo(e.x-r, e.y-t); ctx.lineTo(e.x-r+(r*2*frac), e.y-t); ctx.stroke();
    }

    // particles (blood/sparks)
    for (const p of particles){
      if (p.type==='blood'){
        ctx.fillStyle=p.col;
        ctx.globalAlpha=Math.max(0, p.t/400);
        ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2); ctx.fill();
        ctx.globalAlpha=1;
      } else {
        ctx.fillStyle=p.col;
        ctx.globalAlpha=Math.max(0, p.t/260);
        ctx.fillRect(p.x-1,p.y-1,p.r*1.6,p.r*1.6);
        ctx.globalAlpha=1;
      }
    }

    // player
    ctx.fillStyle='#e9f0ff';
    ctx.strokeStyle='#a2bdf9';
    ctx.lineWidth=4;
    ctx.beginPath(); ctx.arc(player.x,player.y,player.r,0,Math.PI*2); ctx.fill(); ctx.stroke();
    // barrel
    ctx.strokeStyle='#8fb0ff'; ctx.lineWidth=6; ctx.lineCap='round';
    ctx.beginPath();
    ctx.moveTo(player.x,player.y);
    ctx.lineTo(player.x+Math.cos(player.aim)*player.r*1.2, player.y+Math.sin(player.aim)*player.r*1.2);
    ctx.stroke();
  }

  function roundRect(x,y,w,h,r,fill,stroke){
    ctx.beginPath();
    ctx.moveTo(x+r, y);
    ctx.arcTo(x+w, y,   x+w, y+h, r);
    ctx.arcTo(x+w, y+h, x,   y+h, r);
    ctx.arcTo(x,   y+h, x,   y,   r);
    ctx.arcTo(x,   y,   x+w, y,   r);
    if (fill) ctx.fill();
    if (stroke) ctx.stroke();
  }

  function drawHUD(inMenu=false){
    ctx.save();
    ctx.translate(12, 18);
    ctx.fillStyle='#b8c7db';
    ctx.font='16px system-ui';
    if (!inMenu){
      ctx.fillText(`Mode: ${MODES[player.mode]} (L1)`, 0, 0);
      ctx.fillText(`Sprint: L3`, 0, 22);
      ctx.fillText(`HP: ${player.hp}/${player.hpMax}`, 0, 44);
    } else {
      ctx.fillText(`Controller ?`, 0, 0);
      ctx.fillText(`Mode: AUTO`, 0, 22);
    }
    ctx.restore();
  }

  function draw(){
    ctx.clearRect(0,0,VW,VH);
    cam.begin();
    drawWorld();
    cam.end();
    drawHUD(false);
  }

  // ---------- Boot ----------
  function boot(){
    world.spawnMap();
    resetGame();
    requestAnimationFrame(loop);
  }
  boot();

})();