import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {request, VOICE_PART_BYTES} from '../src/voice/contract.js';

// One resident worker, one active generation, at most three waiting phrases.
export class VoiceService {
  constructor(config, send, {spawnWorker, timeoutMs = 120000, queueAgeMs = 45000, now = Date.now} = {}) {
    Object.assign(this, {config, send, timeoutMs, queueAgeMs, now});
    this.spawnWorker = spawnWorker ?? (() => spawn(config.python, ['-u', fileURLToPath(new URL('worker.py', import.meta.url))], {
      stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1'},
    }));
    this.queue = []; this.active = null; this.child = null; this.closed = false;
    this.identity = null; this.voice = null; this.transfer = null;
    this.session = null; this.seen = new Set(); this.seenRequests = new Set();
  }
  receive(value) {
    let m;
    try { m = request(value); } catch { this.send({id: value?.id, error: 'invalid'}); return; }
    if (this.closed) return;
    if (this.seenRequests.has(m.id)) { this.send({id: m.id, error: 'invalid'}); return; }
    this.seenRequests.add(m.id);
    if (this.seenRequests.size > 4096) this.seenRequests.delete(this.seenRequests.values().next().value);
    this.expireTransfer();
    if (m.type === 'voice_part') { this.takePart(m); return; }
    if (m.type === 'voice_load') { this.openTransfer(m); return; }
    if (m.type === 'reset') {
      this.reset(); this.send({id: m.id, value: {reset: true}}); return;
    }
    if (m.type === 'status') {
      this.send({id: m.id, value: {backend: this.config.backend, device: this.device ?? this.config.device,
        mode: this.config.mode, loaded: Boolean(this.ready), queued: this.queue.length, active: Boolean(this.active),
        voice: this.voice ? {state: 'loaded', pack_id: this.voice.pack_id} : {state: 'none'}}}); return;
    }
    if (m.type === 'speak') {
      if (this.session !== null && this.session !== m.job.session) {
        this.send({id: m.id, error: 'invalid'}); return; // New producer requires explicit reset.
      }
      if (this.seen.has(m.job.utterance_id)) { this.send({id: m.id, error: 'invalid'}); return; }
      // Bound deduplication without admitting replay: request an explicit reset after a long session.
      if (this.seen.size >= 10000) { this.send({id: m.id, error: 'expired'}); return; }
    }
    if (this.queue.length >= 3) { this.send({id: m.id, error: 'queue_full'}); return; }
    if (m.type === 'speak') { this.session = m.job.session; this.seen.add(m.job.utterance_id); }
    this.queue.push({message: m, at: this.now()});
    this.pump();
  }
  expireTransfer() {
    if (this.transfer && this.now() - this.transfer.at > this.queueAgeMs) this.endTransfer('expired');
  }
  endTransfer(error) {
    const t = this.transfer; this.transfer = null;
    if (t) this.send({id: t.id, error});
  }
  openTransfer(m) {
    if (this.transfer || this.active?.message.type === 'speak') { this.seenRequests.delete(m.id); this.send({id: m.id, error: 'busy'}); return; } // A refused load may retry under its id.
    this.transfer = {id: m.id, message: m, parts: [], bytes: 0, at: this.now()};
  }
  takePart(m) {
    const t = this.transfer, last = t && m.index === t.message.parts - 1, data = Buffer.from(m.data, 'base64');
    if (!t || m.load !== t.id || m.index !== t.parts.length || m.index >= t.message.parts ||
        t.bytes + data.length > t.message.size || (!last && data.length !== VOICE_PART_BYTES)) {
      this.send({id: m.id, error: 'invalid'}); this.endTransfer('invalid'); return;
    }
    t.parts.push(data); t.bytes += data.length;
    this.send({id: m.id, value: {index: m.index}});
    if (!last) return;
    const pack = Buffer.concat(t.parts); this.transfer = null;
    if (pack.length !== t.message.size || createHash('sha256').update(pack).digest('hex') !== t.message.sha256) { this.send({id: t.id, error: 'invalid'}); return; }
    if (this.queue.length >= 3) { this.send({id: t.id, error: 'queue_full'}); return; }
    const {grant, signature} = t.message;
    this.queue.push({message: {id: t.id, type: 'voice_load', grant, signature, pack: pack.toString('base64')}, at: t.at});
    this.pump();
  }
  pump() {
    if (this.active || this.closed || this.reaping) return;
    while (this.queue.length) {
      const entry = this.queue.shift();
      if (this.now() - entry.at > this.queueAgeMs) { this.send({id: entry.message.id, error: 'expired'}); continue; }
      this.active = entry;
      this.timer = setTimeout(() => this.failWorker('timeout'), this.timeoutMs);
      if (this.ready) this.dispatch(); else if (!this.child) this.startWorker();
      return;
    }
  }
  startWorker() {
    let child;
    try { child = this.child = this.spawnWorker(); } catch { this.failWorker('setup'); return; }
    let pending = '';
    // Logs never enter the Chrome protocol and are not persisted with translated text.
    child.stderr.on('data', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      if (this.child !== child) return;
      pending += data;
      if (Buffer.byteLength(pending) > 256 * 1024) { this.failWorker('failed'); return; }
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try { this.workerMessage(JSON.parse(line)); } catch { this.failWorker('failed'); return; }
        if (this.child !== child) return;
      }
    });
    child.on('error', () => { if (this.child === child) this.failWorker('setup'); });
    child.on('exit', () => {
      if (this.child === child) { this.child = null; this.ready = false; this.failWorker('failed'); }
    });
    child.stdin.on('error', () => { if (this.child === child) this.failWorker('failed'); });
    child.stdin.write(JSON.stringify({type: 'init', config: this.config}) + '\n');
  }
  dispatch() {
    const m = this.active?.message;
    if (!m) return;
    if (m.type === 'warmup') { this.finish({value: {loaded: true, device: this.device, backend: this.config.backend}}); return; }
    if (m.type === 'voice_identity') { this.finish({value: this.identity}); return; }
    if (m.type === 'voice_load') {
      this.child.stdin.write(JSON.stringify({type: 'load_voice', id: m.id, grant: {v: 'voice_grant_v1', grant: m.grant, signature: m.signature}, pack: m.pack}) + '\n'); return;
    }
    this.child.stdin.write(JSON.stringify({type: 'speak', id: m.id, job: m.job}) + '\n');
  }
  workerMessage(m) {
    if (m.type === 'ready') {
      const i = m.identity;
      if (i !== undefined && (!i || !['pack', 'reference', 'preset'].includes(i.voice) || typeof i.model_id !== 'string' || i.model_id.length > 64 ||
          (i.voice === 'pack' && !/^[A-Za-z0-9_-]{43}$/.test(i.public_key)))) throw new Error();
      this.identity = i ?? null; this.ready = true; this.device = m.device; this.dispatch(); return; }
    if (m.type === 'fatal') { this.failWorker('setup'); return; }
    if (!this.active || m.id !== this.active.message.id) return;
    if (m.type === 'pcm') {
      if (typeof m.data !== 'string' || m.data.length > 65536 || !Number.isInteger(m.index) || m.index < 0 || m.sampleRate !== 24000) throw new Error();
      this.send({id: m.id, event: 'pcm', index: m.index, sampleRate: m.sampleRate, data: m.data});
    } else if (m.type === 'done') this.finish({value: m.result});
    else if (m.type === 'voice') {
      const r = m.result;
      if (!r || r.loaded !== true || typeof r.pack_id !== 'string' || typeof r.mode !== 'string') throw new Error();
      this.voice = {pack_id: r.pack_id}; this.finish({value: r});
    } else if (m.type === 'error') this.finish({error: ['invalid', 'no_voice', 'voice'].includes(m.error) ? m.error : 'failed'});
    else throw new Error();
  }
  finish(result) {
    clearTimeout(this.timer);
    const entry = this.active; this.active = null;
    if (entry) this.send({id: entry.message.id, ...result});
    this.pump();
  }
  kill() {
    const child = this.child;
    this.child = null; this.ready = false; this.identity = null; this.voice = null;
    if (!child) return;
    this.reaping = child;
    const reaped = () => { if (this.reaping === child) { this.reaping = null; this.pump(); } };
    child.once('exit', reaped);
    child.once('close', reaped); // Failed spawn emits close without exit.
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 750);
    timer.unref(); child.once('exit', () => clearTimeout(timer)); child.once('close', () => clearTimeout(timer));
  }
  failWorker(error) {
    this.kill(); this.endTransfer(error);
    // Model/load failure must not repeatedly reload on every queued request.
    const waiting = this.queue.splice(0);
    this.finish({error});
    for (const e of waiting) this.send({id: e.message.id, error});
  }
  reset() {
    const waiting = this.queue.splice(0); this.endTransfer('cancelled');
    if (this.active) { this.kill(); this.finish({error: 'cancelled'}); }
    else if (this.ready) this.child.stdin.write('{"type":"reset"}\n');
    for (const e of waiting) this.send({id: e.message.id, error: 'cancelled'});
    this.seen.clear(); this.session = null;
  }
  close() { this.closed = true; this.reset(); this.kill(); }
}
