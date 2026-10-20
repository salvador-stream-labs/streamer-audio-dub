import {FeedClient} from './client.js';

// Connects transport, independent scheduling and bounded asynchronous decoding.
// Browser integration supplies decode(audio, {signal}), a scheduler whose clock
// is AudioContext.currentTime, and the fingerprint matcher callbacks.
export class FeedSession {
  constructor({scheduler, decode, onFingerprints = () => {}, onReset = () => {}, onDrop = () => {},
    onState = () => {}, maxPending = 32, maxDecodes = 2, ...connection}) {
    if (!Number.isInteger(maxPending) || maxPending < 1 || !Number.isInteger(maxDecodes) || maxDecodes < 1) {
      throw new Error('Decode limits must be positive integers.');
    }
    Object.assign(this, {scheduler, decode, onFingerprints, onReset, onDrop, maxPending, maxDecodes});
    this.generation = 0;
    this.syncGeneration = 0;
    this.ready = false;
    this.waiting = [];
    this.decoding = new Set();
    this.seenSpeech = new Set();
    this.client = new FeedClient({...connection, onState, onReset: reason => this.reset(reason),
      onMessage: message => this.receive(message)});
  }

  start() { this.client.start(); }
  stop() { this.client.stop(); }
  setChannel(channel) {
    if (channel === this.client.channel) return;
    const running = !this.client.stopped;
    this.stop();
    this.client.channel = channel;
    if (running) this.start();
  }

  reset(reason) {
    this.generation++;
    this.syncGeneration++;
    this.ready = false;
    this.waiting = [];
    this.seenSpeech.clear();
    for (const job of this.decoding) job.controller.abort();
    // decodeAudioData cannot be cancelled. Count old jobs against concurrency
    // until they settle, and ignore all their late callbacks.
    this.scheduler.reset();
    this.onReset({reason, generation: this.syncGeneration});
  }

  receive(message) {
    if (message.type === 'hello') {
      this.reset('hello');
      this.ready = true;
      return;
    }
    if (!this.ready) return;
    if (message.type === 'fp') {
      this.onFingerprints(message.hashes, this.syncGeneration);
      return;
    }
    // Orphan say text is considered on receipt, before decoding or queue limits.
    this.scheduler.enqueueCaption(message);
    if (message.type !== 'say' || this.seenSpeech.has(message.seq)) return;
    this.seenSpeech.add(message.seq);
    if (this.waiting.length >= this.maxPending) {
      this.onDrop(message.seq, 'decode-overflow', 'say');
      return;
    }
    this.waiting.push({message, generation: this.generation, controller: new AbortController()});
    this.drain();
  }

  setLock(locked, offset, generation = this.syncGeneration) {
    if (generation !== this.syncGeneration || !this.ready) return false;
    this.scheduler.setLock(locked, offset);
    return true;
  }
  setRunning(running) {
    this.scheduler.setRunning(running);
    if (!running) {
      this.syncGeneration++;
      this.onReset({reason: 'playback', generation: this.syncGeneration});
    }
  }
  invalidatePlayback(reason = 'seek') {
    this.scheduler.setLock(false);
    this.syncGeneration++;
    this.onReset({reason, generation: this.syncGeneration});
  }
  setCaptionsVisible(visible) { this.scheduler.setCaptionsVisible(visible); }
  tick() { this.scheduler.tick(); }

  drain() {
    while (this.ready && this.waiting.length && this.decoding.size < this.maxDecodes) {
      const job = this.waiting.shift();
      this.decoding.add(job);
      Promise.resolve().then(() => {
        job.controller.signal.throwIfAborted();
        return this.decode(job.message.audio, {signal: job.controller.signal});
      }).then(audio => {
        if (this.ready && job.generation === this.generation) this.scheduler.enqueue(job.message, audio);
      }).catch(() => {
        if (this.ready && job.generation === this.generation) this.onDrop(job.message.seq, 'decode', 'say');
      }).finally(() => {
        this.decoding.delete(job);
        this.drain();
      });
    }
  }
}
