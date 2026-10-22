import {VERSION, MAX_AUDIO_SECONDS, ERRORS, packParts, job as validateJob} from '../src/voice/contract.js';
import {VoicePlayback} from './playback.js';

/** Import on the viewer page; invoke start() inside its Enable local voice click. */
export class LocalVoice {
  constructor({window: windowObject = globalThis.window, audioContext, onState = () => {}, playback = true, obtainVoice = null, ...playbackOptions} = {}) {
    this.window = windowObject; this.onState = onState;
    this.obtainVoice = obtainVoice;
    this.context = playback ? audioContext ?? new AudioContext() : null; this.ownsContext = playback && !audioContext;
    this.playback = playback ? new VoicePlayback(this.context, {onState, ...playbackOptions}) : null;
    this.pending = new Map(); this.voiceLoading = null; this.generation = 0; this.started = false; this.closed = false;
    this.receive = event => {
      if (event.source !== this.window || event.origin !== this.window.location.origin ||
          event.data?.source !== 'streamir-local-voice' || event.data.v !== VERSION) return;
      const m = event.data;
      if (m.event === 'disconnected' || (!m.id && m.error)) {
        this.invalidate(); this.started = false; this.onState({state: 'disconnected', error: m.error}); return;
      }
      if (m.event === 'connected') { this.onState({state: 'connected'}); return; }
      const entry = this.pending.get(m.id);
      if (!entry) return;
      if (m.event === 'pcm') {
        try {
          if (!entry.audio || m.index !== entry.parts.length || m.sampleRate !== 24000 ||
              typeof m.data !== 'string' || m.data.length > 65536 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(m.data)) throw new Error('Invalid audio chunk');
          const raw = atob(m.data);
          if (!raw.length || raw.length % 2 || entry.samples + raw.length / 2 > 24000 * MAX_AUDIO_SECONDS) throw new Error('Invalid audio size');
          const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
          const view = new DataView(bytes.buffer); const samples = new Float32Array(raw.length / 2);
          for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
          entry.parts.push(samples); entry.samples += samples.length;
        } catch { entry.reject(new Error('Invalid local audio')); this.pending.delete(m.id); clearTimeout(entry.timer); }
      } else {
        clearTimeout(entry.timer); this.pending.delete(m.id);
        if (m.error) entry.reject(new Error(ERRORS[m.error] ?? ERRORS.failed));
        else if (entry.audio) {
          if (!m.value || m.value.samples !== entry.samples || m.value.chunks !== entry.parts.length ||
              m.value.sampleRate !== 24000 || !entry.samples) { entry.reject(new Error('Incomplete local audio')); return; }
          const samples = new Float32Array(entry.samples); let offset = 0;
          for (const part of entry.parts) { samples.set(part, offset); offset += part.length; }
          entry.resolve({samples, info: m.value});
        } else entry.resolve(m.value);
      }
    };
    this.window.addEventListener('message', this.receive);
    this.pagehide = () => this.close();
    this.window.addEventListener('pagehide', this.pagehide, {once: true});
  }
  call(type, payload = {}, id = crypto.randomUUID()) {
    if (this.closed) return Promise.reject(new Error('Local voice closed'));
    if (this.pending.size >= 8) return Promise.reject(new Error(ERRORS.queue_full));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error('Local voice did not respond. Connect the extension and check the helper.'));
      }, type === 'status' ? 2000 : 180000);
      this.pending.set(id, {resolve, reject, timer, audio: type === 'speak', parts: [], samples: 0});
      this.window.postMessage({source: 'streamir-viewer', v: VERSION, id, type, ...payload}, this.window.location.origin);
    });
  }
  async start() {
    // Resume before awaiting model loading so browser user activation is retained.
    await this.context?.resume();
    await this.call('status');
    this.onState({state: 'loading'});
    const generation = this.generation;
    const status = await this.call('warmup');
    if (generation !== this.generation || this.closed) return;
    if (this.obtainVoice) await this.ensureVoice();
    if (generation !== this.generation || this.closed) return;
    this.started = true; this.onState({state: 'ready', ...status});
    return status;
  }
  identity() { return this.call('voice_identity'); }
  // One load at a time: concurrent callers share it; a stale generation abandons it.
  ensureVoice() {
    if (this.voiceLoading) return this.voiceLoading;
    const generation = this.generation, stale = () => generation !== this.generation || this.closed;
    const attempt = async () => {
      const identity = await this.identity();
      if (stale()) return;
      if (identity.voice !== 'pack') { this.onState({state: 'voice', loaded: false, reason: 'not_pack', voice: identity.voice}); return; }
      const voice = await this.obtainVoice(identity);
      if (stale()) return;
      await this.loadVoice(voice, generation);
    };
    const run = (async () => {
      try { await attempt(); }
      catch (error) {
        if (stale()) return;
        if (error.message !== ERRORS.voice) throw error;
        await attempt();
      }
    })().finally(() => { if (this.voiceLoading === run) this.voiceLoading = null; });
    return this.voiceLoading = run;
  }
  async loadVoice({grant, signature, pack}, generation = this.generation) {
    const bytes = pack instanceof Uint8Array ? pack : new Uint8Array(pack);
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    const stale = () => generation !== this.generation || this.closed;
    if (stale()) throw new Error(ERRORS.cancelled);
    const parts = packParts(bytes), id = crypto.randomUUID();
    const load = this.call('voice_load', {grant, signature, size: bytes.length, sha256, parts: parts.length}, id);
    // An early load failure (busy, bad grant) must surface instead of the part errors it causes.
    const failed = new Promise((_, reject) => load.catch(reject)); failed.catch(() => {});
    for (let index = 0; index < parts.length; index++) await Promise.race([this.call('voice_part', {load: id, index, data: parts[index]}), failed]);
    const value = await load;
    if (stale()) throw new Error(ERRORS.cancelled);
    this.onState({state: 'voice', loaded: true, pack_id: value.pack_id, mode: value.mode});
    return value;
  }
  async speak(value) {
    if (!this.started) throw new Error('Enable local voice first');
    const job = validateJob(value), generation = this.generation;
    let result;
    try { result = await this.call('speak', {job}); }
    catch (error) {
      if (error.message !== ERRORS.no_voice || !this.obtainVoice) throw error;
      await this.ensureVoice();
      if (generation !== this.generation || this.closed) return;
      result = await this.call('speak', {job});
    }
    if (generation !== this.generation || this.closed) return;
    this.onState({state: 'generated', ...result.info});
    if (!this.playback) return result;
    this.playback.enqueue(job, result.samples);
    return result.info;
  }
  invalidate() {
    this.generation++; this.voiceLoading = null; this.playback?.reset();
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(ERRORS.cancelled)); }
    this.pending.clear();
  }
  // Mandatory on every hello, reconnect, seek, ad, pause or channel change.
  async reset() { this.invalidate(); return this.call('reset'); }
  async close() {
    if (this.closed) return;
    this.invalidate();
    // Fire-and-forget reset cancels work even when this adapter is destroyed alone.
    this.window.postMessage({source: 'streamir-viewer', v: VERSION, id: crypto.randomUUID(), type: 'reset'}, this.window.location.origin);
    this.closed = true; this.started = false; this.playback?.close();
    this.window.removeEventListener('message', this.receive);
    this.window.removeEventListener('pagehide', this.pagehide);
    if (this.ownsContext) await this.context.close();
  }
}
