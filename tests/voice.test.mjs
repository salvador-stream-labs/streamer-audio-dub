import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {VoiceService} from '../native/service.mjs';
import {frame, decoder} from '../native/protocol.mjs';
import {job, request, VERSION, allowedPage} from '../src/voice/contract.js';
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
