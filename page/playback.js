// The viewer supplies a verified mapping to its AudioContext clock. Arrival time
// and Twitch wall time are deliberately never treated as source-clock timestamps.
export class VoicePlayback {
  constructor(context, {targetTime = () => null, timing = 'synchronized', maxLateSeconds = 20,
    onState = () => {}, onSpeaking = () => {}, now = () => performance.now()} = {}) {
    if (!['synchronized', 'as-ready'].includes(timing) || !Number.isFinite(maxLateSeconds) || maxLateSeconds < 0 || maxLateSeconds > 60) throw new Error('Invalid playback policy');
    Object.assign(this, {context, targetTime, timing, maxLateSeconds, onState, onSpeaking, now});
    this.queue = []; this.active = null; this.enabled = true;
    this.timer = setInterval(() => this.tick(), 50);
  }
  enqueue(job, samples) {
    if (!this.enabled) return;
    if (this.queue.length >= 3) { this.onState({state: 'skipped', reason: 'playback_queue_full'}); return; }
    this.queue.push({job, samples, received: this.now()});
    this.queue.sort((a, b) => a.job.t_start - b.job.t_start);
    this.tick();
  }
  tick() {
    if (!this.enabled || this.context.state !== 'running') return;
    if (this.active) return;
    while (this.queue.length) {
      const item = this.queue[0];
      const mapped = this.timing === 'as-ready' ? this.context.currentTime : this.targetTime(item.job);
      if (this.now() - item.received > 45000) {
        this.queue.shift(); this.onState({state: 'skipped', reason: 'playback_expired'}); continue;
      }
      if (mapped === null || !Number.isFinite(mapped)) { this.onState({state: 'waiting_for_clock'}); return; }
      const lateness = Math.max(0, this.context.currentTime - mapped);
      if (lateness > this.maxLateSeconds) {
        this.queue.shift(); this.onState({state: 'skipped', reason: 'late', lateness}); continue;
      }
      if (mapped > this.context.currentTime + .05) return;
      this.queue.shift();
      const buffer = this.context.createBuffer(1, item.samples.length, 24000);
      buffer.copyToChannel(item.samples, 0);
      const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
      this.active = source;
      source.onended = () => {
        source.disconnect();
        if (this.active !== source) return;
        this.active = null; this.onSpeaking(false); this.tick();
      };
      // The page uses this hook to duck its player. No Twitch DOM or caption access.
      this.onSpeaking(true);
      this.onState({state: 'playing', lateness, synchronized: this.timing === 'synchronized'});
      source.start(Math.max(mapped, this.context.currentTime));
      return;
    }
  }
  reset() {
    this.queue = [];
    const source = this.active; this.active = null;
    if (source) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); }
    this.onSpeaking(false);
  }
  close() { this.enabled = false; clearInterval(this.timer); this.reset(); }
}
