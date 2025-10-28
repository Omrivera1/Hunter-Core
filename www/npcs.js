export class NPC {
  constructor(x,y){ this.x=x; this.y=y; this.r=12; this.state='idle'; this.speed=1.6; this.alert=0; }
  tick(dt, player){
    const dx=player.x-this.x, dy=player.y-this.y; const dist=Math.hypot(dx,dy);
    if(dist<260) this.alert=Math.min(1,this.alert+dt*0.5); else this.alert=Math.max(0,this.alert-dt*0.2);
    if(this.alert>0.7) this.state='pursue'; else if(this.alert>0.3) this.state='investigate'; else this.state='idle';

    if(this.state==='pursue'){
      const a=Math.atan2(dy,dx);
      this.x+=Math.cos(a)*this.speed*dt*60;
      this.y+=Math.sin(a)*this.speed*dt*60;
    } else if(this.state==='investigate'){
      const a=Math.atan2(dy,dx);
      this.x+=Math.cos(a)*this.speed*0.4*dt*60;
      this.y+=Math.sin(a)*this.speed*0.4*dt*60;
    }
  }
  draw(ctx, cam){
    ctx.fillStyle=this.state==='pursue'?'#ff3b3b':(this.state==='investigate'?'#ffc43b':'#6fa8ff');
    ctx.beginPath(); ctx.arc(this.x-cam.x, this.y-cam.y, this.r, 0, Math.PI*2); ctx.fill();
  }
}