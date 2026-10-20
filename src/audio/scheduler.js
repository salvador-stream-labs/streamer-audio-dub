// All times use the playback AudioContext clock. Never add clock_epoch.
// The owner calls tick() on its playback clock and supplies a cancellable play():
// play(entry, at, ended) schedules the decoded buffer and returns stop().
// ended must reflect decoded audio completion, not the original source span.
export class FeedScheduler {
  constructor({now, play, showCaption = () => {}, clearCaption, restoreGain = () => {},
    onDrop = () => {}, maxSpeech = 128, maxCaptions = 128}) {
    if (!Number.isInteger(maxSpeech) || maxSpeech < 1 || !Number.isInteger(maxCaptions) || maxCaptions < 1) {
      throw new Error('Queue limits must be positive integers.');
    }
    Object.assign(this, {now, play, showCaption, clearCaption, restoreGain, onDrop, maxSpeech, maxCaptions});
    this.running = true;
    this.captionsVisible = true;
    this.reset();
  }

  reset() {
    const active = this.active;
    this.active = null; // Late ended callbacks must not affect a new timeline.
    active?.stop();
    this.restoreGain();
    this.pending = [];
    this.captions = new Map();
    this.seenSpeech = new Set();
    this.seenCaptions = new Set();
    this.displayed = null;
    this.offset = null;
    this.locked = false;
    this.clearCaption();
  }

  enqueueCaption(sentence) {
    if (this.seenCaptions.has(sentence.seq)) return false;
    this.seenCaptions.add(sentence.seq);
    this.captions.set(sentence.seq, {
      seq: sentence.seq, t_start: sentence.t_start, t_end: sentence.t_end, text_en: sentence.text_en,
    });
    this.tickCaptions();
    if (this.captions.size > this.maxCaptions) {
      const sorted = [...this.captions.values()].sort((a, b) => a.t_start - b.t_start || a.seq - b.seq);
      // Unlocked: keep recent spans. Locked: prefer present/near-future text.
      const dropped = this.locked && this.running ? sorted.at(-1) : sorted[0];
      this.captions.delete(dropped.seq);
      this.onDrop(dropped.seq, 'overflow', 'caption');
      this.tickCaptions();
    }
    return true;
  }

  enqueue(sentence, audio) {
    this.enqueueCaption(sentence);
    if (this.seenSpeech.has(sentence.seq)) return false;
    this.seenSpeech.add(sentence.seq);
    if (this.pending.length >= this.maxSpeech) {
      this.onDrop(sentence.seq, 'overflow', 'say');
      return false;
    }
    this.pending.push({sentence, audio});
    // Decode completion and network interleaving need not follow sequence order.
    this.pending.sort((a, b) => a.sentence.t_start - b.sentence.t_start || a.sentence.seq - b.sentence.seq);
    this.tick();
    return true;
  }

  interrupt() {
    const active = this.active;
    this.active = null;
    if (active) {
      active.stop();
      if (this.now() < active.at) {
        if (this.pending.length >= this.maxSpeech) {
          const dropped = this.pending.pop();
          this.onDrop(dropped.sentence.seq, 'overflow', 'say');
        }
        this.pending.push(active.entry);
        this.pending.sort((a, b) => a.sentence.t_start - b.sentence.t_start || a.sentence.seq - b.sentence.seq);
      } else this.onDrop(active.entry.sentence.seq, 'interrupted', 'say');
    }
    this.restoreGain();
    this.display(null);
  }

  setLock(locked, offset = this.offset) {
    if (locked && !Number.isFinite(offset)) throw new Error('Synchronization needs a finite offset.');
    if (!locked || (this.locked && Math.abs(offset - this.offset) > 0.1)) this.interrupt();
    this.locked = Boolean(locked && this.running);
    this.offset = offset;
    this.tick();
  }

  // A resumed player requires a fresh lock; running alone cannot replay audio.
  setRunning(running) {
    this.running = Boolean(running);
    if (!this.running) this.setLock(false);
    else this.tick();
  }

  setCaptionsVisible(visible) {
    this.captionsVisible = Boolean(visible);
    this.tickCaptions();
  }

  display(caption) {
    if (this.displayed?.seq === caption?.seq) return;
    this.displayed = caption;
    if (caption) this.showCaption(caption);
    else this.clearCaption();
  }

  tickCaptions() {
    if (!this.locked || !this.running) { this.display(null); return; }
    const now = this.now();
    let current = null;
    for (const [seq, caption] of this.captions) {
      if (now >= caption.t_end + this.offset) {
        this.captions.delete(seq);
      } else if (now >= caption.t_start + this.offset &&
          (!current || caption.t_start > current.t_start ||
            (caption.t_start === current.t_start && seq > current.seq))) {
        current = caption;
      }
    }
    this.display(this.captionsVisible ? current : null);
  }

  tick() {
    this.tickCaptions();
    if (!this.locked || !this.running || this.active) return;
    while (this.pending.length) {
      const entry = this.pending[0];
      const target = entry.sentence.t_start + this.offset;
      const now = this.now();
      if (now - target > 5) {
        this.pending.shift();
        this.onDrop(entry.sentence.seq, 'late', 'say');
        continue;
      }
      // Only near-future buffers reach Web Audio. Recheck after each prior dub.
      if (target > now + 0.15) return;
      this.pending.shift();
      const active = {entry, at: Math.max(now, target), stop: () => {}};
      this.active = active;
      try {
        active.stop = this.play(entry, active.at, () => {
          if (this.active !== active) return;
          this.active = null;
          // Caption lifetime is independent of playback completion.
          this.tick();
        });
      } catch {
        this.active = null;
        this.restoreGain();
        this.onDrop(entry.sentence.seq, 'playback', 'say');
        continue;
      }
      return;
    }
  }
}
