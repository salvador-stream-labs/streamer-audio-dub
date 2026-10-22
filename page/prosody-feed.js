import {job as validateJob} from '../src/voice/contract.js';

const fields = (value, expected) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) throw new Error('Invalid prosody feed fields');
};
const seq = value => Number.isSafeInteger(value) && value >= 0;
const identity = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;

/** Memory-only adapter for an opted-in feed_v3 connection and an enabled LocalVoice.
 * The page still owns captions, the WebSocket and verified playback-clock mapping.
 */
export class ProsodyFeed {
  constructor({voice, channel, language = 'en', speakerId = null, onState = () => {}, now = Date.now}) {
    if (!/^[a-z0-9_]{1,25}$/.test(channel) || !['en', 'de'].includes(language)) throw new Error('Invalid feed selection');
    Object.assign(this, {voice, channel, language, speakerId, onState, now});
    this.pending = new Map(); this.generation = 0; this.session = null;
    this.lastCaption = -1; this.speakers = []; this.ready = Promise.resolve();
  }
  url(base) {
    const url = new URL(base);
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('Expected WebSocket URL');
    url.pathname = `/feed/${this.channel}`;
    url.search = `v=feed_v3&lang=${this.language}&prosody=1`; url.hash = '';
    return url.href;
  }
  reset() {
    this.generation++; this.pending.clear(); this.session = null; this.lastCaption = -1;
    this.ready = Promise.resolve(this.voice.reset());
    return this.ready;
  }
  accept(raw) {
    if (typeof raw !== 'string' || raw.length > 1400000) throw new Error('Invalid feed frame');
    const m = JSON.parse(raw);
    if (!m || typeof m !== 'object') throw new Error('Invalid feed frame');
    // These remain the page's responsibility; server speech is never sent to local playback.
    if (m.type === 'fp') return null;
    if (m.v !== 'feed_v3') throw new Error('Expected feed_v3');
    if (m.type === 'hello') {
      fields(m, ['type', 'v', 'channel', 'clock_epoch', 'lang', 'source_language', 'speakers', 'analysis_session']);
      if (m.channel !== this.channel || m.lang !== this.language || !identity(m.analysis_session) ||
          !Array.isArray(m.speakers)) throw new Error('Invalid prosody hello');
      const ready = this.reset();
      this.session = m.analysis_session; this.speakers = m.speakers;
      return ready;
    }
    if (!this.session) throw new Error('Feed needs hello');
    if (m.type === 'speaker_labels') {
      fields(m, ['type', 'v', 'speakers']);
      if (!Array.isArray(m.speakers)) throw new Error('Invalid speakers');
      this.speakers = m.speakers; return null;
    }
    if (m.type === 'say') return null;
    const now = this.now();
    for (const [key, value] of this.pending) if (now - value.at > 30000) this.pending.delete(key);
    if (m.type === 'prosody') {
      fields(m, ['type', 'v', 'seq', 'analysis']);
      const p = m.analysis;
      if (!seq(m.seq) || !p || p.version !== 'source_prosody_v1' || p.utterance_id !== String(m.seq) ||
          !identity(p.session) || JSON.stringify(p).length > 8192) throw new Error('Invalid prosody identity');
      if (p.session !== this.session || m.seq <= this.lastCaption) {
        this.onState({state: 'prosody_ignored', reason: p.session !== this.session ? 'stale_session' : 'late'});
        return null;
      }
      if (!this.pending.has(m.seq)) this.pending.set(m.seq, {analysis: p, at: now});
      while (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value);
      return null;
    }
    if (m.type !== 'caption') throw new Error('Unknown feed event');
    fields(m, ['type', 'v', 'seq', 't_start', 't_end', 'text', 'lang', 'speaker_id']);
    if (!seq(m.seq) || m.lang !== this.language) throw new Error('Invalid caption');
    if (m.seq <= this.lastCaption) return null;
    this.lastCaption = m.seq;
    const analysis = this.pending.get(m.seq)?.analysis ?? null;
    for (const key of this.pending.keys()) if (key <= m.seq) this.pending.delete(key);
    // A single cloned voice must not learn its baseline from other speakers.
    if ((this.speakerId !== null && m.speaker_id !== this.speakerId) ||
        (this.speakerId === null && this.speakers.length > 1)) {
      this.onState({state: 'skipped', reason: 'select_source_speaker'}); return null;
    }
    const job = validateJob({session: this.session, utterance_id: String(m.seq), text: m.text,
      language: m.lang, t_start: m.t_start, t_end: m.t_end, prosody: analysis});
    const generation = this.generation;
    this.onState({state: 'prosody_matched', available: analysis !== null});
    return this.ready.then(() => generation === this.generation ? this.voice.speak(job) : null);
  }
}
