import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {VoiceService} from '../native/service.mjs';
import {frame, decoder} from '../native/protocol.mjs';
import {job, request, VERSION, allowedPage, VOICE_PACK_MAX_BYTES, VOICE_PART_BYTES, VOICE_PART_CHARS, ERRORS, packParts} from '../src/voice/contract.js';
import {config} from '../native/config.mjs';
const phrase = (id = '1') => ({session: 'producer', utterance_id: id, text: 'Thank you.', language: 'en', t_start: 10, t_end: 12, prosody: null});
const message = (id, type = 'speak', value = phrase(id)) => ({id, v: VERSION, type, ...(type === 'speak' ? {job: value} : {})});
function fixture(options = {}) {
  const output = [], workers = [];
  const service = new VoiceService({backend: 'mlx', device: 'metal', mode: 'custom_voice'}, m => output.push(m), {
    ...options, spawnWorker() {
      const c = new EventEmitter(); c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
      c.commands = []; c.stdin.on('data', data => c.commands.push(JSON.parse(data)));
      c.kill = signal => { c.killed = signal; queueMicrotask(() => c.emit('exit', 0)); };
      c.respond = value => c.stdout.write(JSON.stringify(value) + '\n'); workers.push(c); return c;
    },
  });
  return {service, output, workers};
}
test('local requests validate identities, language, bounds and exact fields', () => {
  assert.equal(job(phrase()).text, 'Thank you.');
  for (const changes of [{text: 'x'.repeat(1001)}, {language: 'constructor'}, {t_end: Infinity}, {t_start: -1}, {t_end: 50}, {extra: true}, {prosody: {version: 'source_prosody_v1', session: 'other', utterance_id: '1'}}]) assert.throws(() => job({...phrase(), ...changes}));
  assert.throws(() => request({...message('a'), v: 'feed_v1'}));
  assert.throws(() => request({...message('a'), command: 'sh'}));
});
test('only secure viewer pages and loopback development pages can be activated', () => {
  for (const url of ['https://viewer.example/watch', 'http://localhost:8080/', 'http://127.0.0.1:8000']) assert.equal(allowedPage(url), true);
  for (const url of ['http://example.com/', 'file:///etc/passwd', 'chrome://settings', 'http://localhost.example.com']) assert.equal(allowedPage(url), false);
});
test('model configuration cannot select remote models or page-controlled executables', () => {
  const c = {python: '/python', modelPath: '/model', backend: 'mlx', device: 'metal', mode: 'custom_voice', speaker: 'Ryan'};
  assert.equal(config(c).speaker, 'Ryan');
  for (const patch of [{python: 'python'}, {modelPath: 'Qwen/model'}, {device: 'cuda'}, {mode: 'base'}, {speaker: '../file'}]) assert.throws(() => config({...c, ...patch}));
});
test('pack mode pins one to four server keys and carries no reference files', () => {
  const base = {python: '/python', modelPath: '/model', backend: 'mlx', device: 'metal', mode: 'base'};
  const key = 'A'.repeat(43);
  assert.deepEqual(config({...base, voice: 'pack', voicePublicKeys: [key]}), {...base, voice: 'pack', voicePublicKeys: [key]});
  assert.equal(config({...base, referenceAudio: '/ref.wav', referenceText: 'hi'}).voice, 'reference');
  for (const patch of [{voicePublicKeys: []}, {voicePublicKeys: [key, key, key, key, key]}, {voicePublicKeys: ['A'.repeat(42)]}, {voicePublicKeys: [key], referenceAudio: '/ref.wav'}, {voice: 'preset'}]) assert.throws(() => config({...base, voice: 'pack', ...patch}));
});
test('Chrome framing handles fragmented UTF-8 and rejects oversized frames', () => {
  const out = [], accept = decoder(m => out.push(m)), bytes = frame({text: 'Привет'});
  for (const b of bytes) accept(Buffer.from([b]));
  assert.deepEqual(out, [{text: 'Привет'}]);
  const large = Buffer.alloc(4); large.writeUInt32LE(1000000); assert.throws(() => decoder(() => {})(large));
});
test('worker stays resident and emits bounded PCM before completion', t => {
  const {service: s, workers: w, output: o} = fixture(); t.after(() => s.close());
  s.receive(message('warm', 'warmup')); w[0].respond({type: 'ready', device: 'metal'});
  s.receive(message('one')); w[0].respond({type: 'pcm', id: 'one', index: 0, sampleRate: 24000, data: 'AAA='});
  w[0].respond({type: 'done', id: 'one', result: {samples: 1}});
  s.receive(message('two'));
  assert.equal(w.length, 1); assert.equal(w[0].commands.at(-1).id, 'two');
  assert.equal(o[0].value.loaded, true); assert.equal(o[1].event, 'pcm');
});
test('queue is bounded, deduplicates utterances and requires reset for new producer', t => {
  const {service: s, output: o} = fixture(); t.after(() => s.close());
  for (let i = 1; i <= 5; i++) s.receive(message(String(i)));
  assert.equal(o.at(-1).error, 'queue_full');
  s.receive(message('duplicate', 'speak', phrase('1'))); assert.equal(o.at(-1).error, 'invalid');
  s.receive(message('other', 'speak', {...phrase('other'), session: 'new'})); assert.equal(o.at(-1).error, 'invalid');
});
test('reset cancels running and queued work and suppresses old worker output', async t => {
  const {service: s, workers: w, output: o} = fixture(); t.after(() => s.close());
  s.receive(message('one')); const old = w[0]; old.respond({type: 'ready', device: 'metal'});
  s.receive(message('two')); s.receive(message('reset', 'reset'));
  const n = o.length; old.respond({id: 'one', type: 'done', result: {samples: 1}});
  assert.equal(o.length, n); assert.equal(o.filter(m => m.error === 'cancelled').length, 2);
  s.receive(message('three', 'speak', {...phrase('3'), session: 'new'}));
  assert.equal(w.length, 1); // Do not overlap old and new GPU processes.
  await Promise.resolve(); assert.equal(w.length, 2);
});
test('queue age expires instead of building a speech backlog', t => {
  let time = 0;
  const {service: s, workers: w, output: o} = fixture({now: () => time}); t.after(() => s.close());
  s.receive(message('one')); w[0].respond({type: 'ready', device: 'metal'}); s.receive(message('two'));
  time = 46000; w[0].respond({id: 'one', type: 'done', result: {samples: 1}});
  assert.equal(o.at(-1).error, 'expired');
});
test('watchdog kills an unresponsive model and clears queued work', async t => {
  const {service: s, workers: w, output: o} = fixture({timeoutMs: 15}); t.after(() => s.close());
  s.receive(message('one')); s.receive(message('two'));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(w[0].killed, 'SIGTERM'); assert.equal(o.filter(m => m.error === 'timeout').length, 2);
});

test('voice requests validate identity, load declarations and parts', () => {
  const load = {v: VERSION, id: 'load', type: 'voice_load', grant: {v: 'voice_grant_v1'}, signature: 'A'.repeat(86), size: 20000, sha256: 'a'.repeat(64), parts: 2};
  assert.equal(request({v: VERSION, id: 'i', type: 'voice_identity'}).type, 'voice_identity');
  assert.equal(request(load).parts, 2);
  for (const patch of [{parts: 3}, {size: 0}, {size: VOICE_PACK_MAX_BYTES + 1, parts: 257}, {signature: 'A'.repeat(85)}, {sha256: 'g'.repeat(64)}, {grant: {v: 'other'}}, {grant: {v: 'voice_grant_v1', pad: 'x'.repeat(4096)}}, {extra: 1}]) assert.throws(() => request({...load, ...patch}));
  const part = {v: VERSION, id: 'p0', type: 'voice_part', load: 'load', index: 0, data: 'AAAA'};
  assert.equal(request(part).index, 0);
  for (const patch of [{index: -1}, {index: 256}, {data: ''}, {data: 'AAA'}, {data: 'A'.repeat(VOICE_PART_CHARS + 4)}, {data: 'AA A='}, {load: 'bad id!'}]) assert.throws(() => request({...part, ...patch}));
  assert.equal(ERRORS.no_voice, 'Load the streamer voice first.');
});
test('packParts splits at 16 KiB and encodes without Buffer', () => {
  const bytes = new Uint8Array(VOICE_PART_BYTES * 2 + 1).fill(7);
  const parts = packParts(bytes);
  assert.equal(parts.length, 3); assert.equal(parts[0].length, VOICE_PART_CHARS); assert.equal(parts[2], 'Bw==');
  assert.deepEqual(Buffer.concat(parts.map(p => Buffer.from(p, 'base64'))), Buffer.from(bytes));
});
const grant = {v: 'voice_grant_v1', channel: 'hexxyi'};
function transfer(s, bytes, id = 'load') {
  const parts = packParts(bytes);
  s.receive({id, v: VERSION, type: 'voice_load', grant, signature: 'A'.repeat(86), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), parts: parts.length});
  parts.forEach((data, index) => s.receive({id: `${id}-${index}`, v: VERSION, type: 'voice_part', load: id, index, data}));
}
test('identity and voice state come from the worker and clear on restart', async t => {
  const {service: s, workers: w, output: o} = fixture(); t.after(() => s.close());
  s.receive(message('who', 'voice_identity'));
  w[0].respond({type: 'ready', device: 'metal', identity: {voice: 'pack', model: {enc_dim: 8}, model_id: 'qwen3_tts-base-test-12hz', public_key: 'B'.repeat(43)}});
  assert.equal(o.at(-1).value.public_key, 'B'.repeat(43));
  s.receive(message('st', 'status')); assert.deepEqual(o.at(-1).value.voice, {state: 'none'});
  transfer(s, new Uint8Array(10));
  assert.equal(w[0].commands.at(-1).type, 'load_voice'); assert.equal(JSON.stringify(w[0].commands.at(-1)).startsWith('{"type":"load_voice"'), true);
  w[0].respond({type: 'voice', id: 'load', result: {loaded: true, pack_id: 'p', mode: 'icl'}});
  assert.deepEqual(o.at(-1).value, {loaded: true, pack_id: 'p', mode: 'icl'});
  s.receive(message('st2', 'status')); assert.deepEqual(o.at(-1).value.voice, {state: 'loaded', pack_id: 'p'});
  s.receive(message('one')); s.receive(message('reset', 'reset')); await Promise.resolve();
  s.receive(message('st3', 'status')); assert.deepEqual(o.at(-1).value.voice, {state: 'none'});
});
test('voice transfer rejects stray, reordered and oversized parts', t => {
  const {service: s, workers: w, output: o} = fixture(); t.after(() => s.close());
  s.receive(message('warm', 'warmup')); w[0].respond({type: 'ready', device: 'metal'});
  s.receive({id: 'stray', v: VERSION, type: 'voice_part', load: 'nope', index: 0, data: 'AAAA'}); assert.equal(o.at(-1).error, 'invalid');
  const bytes = new Uint8Array(VOICE_PART_BYTES + 5).fill(1), parts = packParts(bytes);
  s.receive({id: 'load', v: VERSION, type: 'voice_load', grant, signature: 'A'.repeat(86), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), parts: 2});
  s.receive({id: 'again', v: VERSION, type: 'voice_load', grant, signature: 'A'.repeat(86), size: 4, sha256: 'a'.repeat(64), parts: 1}); assert.equal(o.at(-1).error, 'busy');
  s.receive({id: 'p1', v: VERSION, type: 'voice_part', load: 'load', index: 1, data: parts[1]}); assert.equal(o.at(-1).error, 'invalid');
  assert.equal(s.transfer, null);
  transfer(s, bytes, 'ok'); w[0].respond({type: 'voice', id: 'ok', result: {loaded: true, pack_id: 'p', mode: 'icl'}});
  s.receive({id: 'big', v: VERSION, type: 'voice_load', grant, signature: 'A'.repeat(86), size: 4, sha256: 'b'.repeat(64), parts: 1});
  s.receive({id: 'big-0', v: VERSION, type: 'voice_part', load: 'big', index: 0, data: packParts(new Uint8Array(10))[0]});   // 10 bytes exceed the declared 4
  assert.equal(o.at(-1).error, 'invalid'); assert.equal(s.transfer, null);
  s.receive({id: 'bad', v: VERSION, type: 'voice_load', grant, signature: 'A'.repeat(86), size: 10, sha256: 'b'.repeat(64), parts: 1});
  s.receive({id: 'bad-0', v: VERSION, type: 'voice_part', load: 'bad', index: 0, data: packParts(new Uint8Array(10))[0]});  // digest mismatch
  assert.equal(o.at(-1).error, 'invalid');
  s.receive({id: 'late', v: VERSION, type: 'voice_part', load: 'bad', index: 1, data: 'AAAA'}); assert.equal(o.at(-1).error, 'invalid');
});
test('load waits behind generation, and worker voice errors reach the page unchanged', t => {
  const {service: s, workers: w, output: o} = fixture(); t.after(() => s.close());
  s.receive(message('one')); w[0].respond({type: 'ready', device: 'metal'});
  s.receive({id: 'load', v: VERSION, type: 'voice_load', grant, signature: 'A'.repeat(86), size: 4, sha256: 'a'.repeat(64), parts: 1}); assert.equal(o.at(-1).error, 'busy');
  w[0].respond({type: 'error', id: 'one', error: 'no_voice'}); assert.equal(o.at(-1).error, 'no_voice');
  transfer(s, new Uint8Array(4)); w[0].respond({type: 'error', id: 'load', error: 'voice'}); assert.equal(o.at(-1).error, 'voice');
});
