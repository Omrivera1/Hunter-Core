import { Audio } from './audio.js';
import { NPC } from './npcs.js';

const canvas=document.getElementById('c'); const ctx=canvas.getContext('2d');
const statusEl=document.getElementById('status');

let gpIndex=null; let keys=new Set();
let player={x:500,y:400, r:12, facing:0, speed:3.2, dashCD:0};
let cam={x:0,y:0};
const npcs=[new NPC(900,500), new NPC(1200,350), new NPC(700,900)];

function getGamepad(){
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  return pads && (pads[gpIndex] || pads[0]) || null;
}

window.addEventListener('gamepadconnected', e=>{ gpIndex=e.gamepad.index; statusEl.textContent=`Controller: ${e.gamepad.id}`; });
window.addEventListener('gamepaddisconnected', ()=>{statusEl.textContent='Controller disconnected — press a button to reconnect'; gpIndex=null; });

window.addEventListener('keydown', e=>keys.add(e.code));
window.addEventListener('keyup', e=>keys.delete(e.code));

function readInput(){
  const gp=getGamepad();
  let lx=0, ly=0, rx=0, ry=0, fire=false, dash=false;
  if(gp){
    const a=gp.axes||[], b=gp.buttons||[];
    lx=(a[0]||0); ly=(a[1]||0); rx=(a[2]||0); ry=(a[3]||0);
    fire=!!b[7]?.pressed || !!b[6]?.pressed;   // triggers
    dash=!!b[0]?.pressed;                      // A/Cross
  } else {
    lx=(keys.has('ArrowRight')||keys.has('KeyD'))?1:((keys.has('ArrowLeft')||keys.has('KeyA'))?-1:0);
    ly=(keys.has('ArrowDown')||keys.has('KeyS'))?1:((keys.has('ArrowUp')||keys.has('KeyW'))?-1:0);
    fire=keys.has('Space');
    dash=keys.has('ShiftLeft');
  }
  return {lx,ly,rx,ry,fire,dash};
}

const bullets=[];
function shoot(){
  const a=player.facing; const spd=8;
  bullets.push({x:player.x+Math.cos(a)*18,y:player.y+Math.sin(a)*18,dx:Math.cos(a)*spd,dy:Math.sin(a)*spd,t:0});
  const r=0.96+Math.random()*0.08; Audio.playSfx('hit',{rate:r,vol:0.95});
}

function dash(){
  if(player.dashCD>0) return;
  player.x+=Math.cos(player.facing)*38; player.y+=Math.sin(player.facing)*38;
  player.dashCD=0.35; Audio.playSfx('dash',{rate:1.05});
}

let last=0;
export function startGame(){
  requestAnimationFrame(loop);
}
function loop(ts){
  const dt=Math.min(0.033,(ts-last)/1000||0.016); last=ts;
  tick(dt); draw(); requestAnimationFrame(loop);
}

function tick(dt){
  const {lx,ly,rx,ry,fire,dash:dashBtn}=readInput();

  const m = Math.hypot(lx,ly); const dead=0.2;
  let dx=0, dy=0;
  if(m>dead){ const ang=Math.atan2(ly,lx); dx=Math.cos(ang)*player.speed; dy=Math.sin(ang)*player.speed; }
  player.x+=dx; player.y+=dy;

  if(Math.hypot(rx,ry)>0.25){ player.facing=Math.atan2(ry,rx); }
  else if(m>dead){ player.facing=Math.atan2(ly,lx); }

  if(fire && bullets.length<8) shoot();
  if(dashBtn) dash();
  player.dashCD=Math.max(0,player.dashCD-dt);

  for(let i=bullets.length-1;i>=0;i--){
    const b=bullets[i]; b.x+=b.dx; b.y+=b.dy; b.t+=dt;
    if(b.t>1.5) bullets.splice(i,1);
  }

  cam.x += (player.x - cam.x - canvas.width*0.5)*0.08;
  cam.y += (player.y - cam.y - canvas.height*0.5)*0.08;

  statusEl.textContent = getGamepad()
    ? `Controller OK`
    : 'No controller — press any button to wake';
}

function draw(){
  ctx.clearRect(0,0,canvas.width,canvas.height);

  ctx.save();
  ctx.translate(-cam.x, -cam.y);
  ctx.strokeStyle='rgba(255,255,255,0.06)';
  ctx.lineWidth=1;
  for(let x=-1000;x<3000;x+=40){ ctx.beginPath(); ctx.moveTo(x,-1000); ctx.lineTo(x,3000); ctx.stroke(); }
  for(let y=-1000;y<3000;y+=40){ ctx.beginPath(); ctx.moveTo(-1000,y); ctx.lineTo(3000,y); ctx.stroke(); }

  ctx.fillStyle='#ffd36b';
  bullets.forEach(b=>{ ctx.fillRect(b.x-2 - cam.x, b.y-2 - cam.y, 4, 4); });

  const px=player.x - cam.x, py=player.y - cam.y;
  ctx.fillStyle='#e9eef9'; ctx.beginPath(); ctx.arc(px,py,player.r,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle='#9bb7ff'; ctx.beginPath(); ctx.moveTo(px,py); ctx.lineTo(px+Math.cos(player.facing)*24, py+Math.sin(player.facing)*24); ctx.stroke();

  ctx.restore();
}