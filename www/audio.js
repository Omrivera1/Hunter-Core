class AudioManager {
  constructor(){
    this.ctx = null;
    this.master = null;
    this.musicBus = null;
    this.sfxBus = null;
    this.buffers = new Map();
    this.currentMusic = null;
  }

  async unlock(){
    if (this.ctx && this.ctx.state !== 'suspended') return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'interactive',
      sampleRate: 44100
    });
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(this.ctx.destination);
    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = 0.8;
    this.musicBus.connect(this.master);
    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = 1;
    this.sfxBus.connect(this.master);
    await this.ctx.resume();
  }

  async load(name, url){
    if (this.buffers.has(name)) return;
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(arr);
    this.buffers.set(name, buf);
  }

  _ramp(param, value, time = 0.2){
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + Math.max(0.001, time));
  }

  _play(buf, { bus, loop = false, loopStart = 0, loopEnd = 0, vol = 1, rate = 1 } = {}){
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    if (loop && loopEnd > loopStart) {
      src.loopStart = loopStart;
      src.loopEnd = loopEnd;
    }
    src.playbackRate.value = rate;

    const g = this.ctx.createGain();
    g.gain.value = vol;

    src.connect(g);
    g.connect(bus || this.sfxBus);
    src.start();

    return { src, g };
  }

  playSfx(name, { vol = 1, rate = 1 } = {}){
    const buf = this.buffers.get(name);
    if (!buf) return null;
    return this._play(buf, { loop: false, vol, rate });
  }

  playMusic(name, { vol = 0.8, loop = true, loopStart = 0, loopEnd = 0, fade = 0.6 } = {}){
    const buf = this.buffers.get(name);
    if (!buf) return null;

    if (this.currentMusic) {
      const { src, g } = this.currentMusic;
      this._ramp(g.gain, 0, fade);
      setTimeout(() => { try { src.stop(); } catch {} }, fade * 1000 + 50);
    }

    const { src, g } = this._play(buf, {
      bus: this.musicBus,
      loop,
      loopStart,
      loopEnd,
      vol: 0.0001
    });

    this._ramp(g.gain, vol, fade);
    this.currentMusic = { src, g, name };
    return this.currentMusic;
  }
}

export const Audio = new AudioManager();

export async function bootAudioAndPreload(manifest){
  await Audio.unlock();
  await Promise.all(Object.entries(manifest).map(([name, url]) =>
    Audio.load(name, url).catch(() => {})
  ));
}