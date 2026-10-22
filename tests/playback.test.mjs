import test from 'node:test';
import assert from 'node:assert/strict';
import {VoicePlayback} from '../page/playback.js';
function setup(options = {}) {
  const states = [], speaking = [], sources = [];
  const context = {state: 'running', currentTime: 100, destination: {},
    createBuffer: () => ({copyToChannel() {}}),
    createBufferSource() { const source = {connect() {}, disconnect() {}, start(at) { this.at = at; }, stop() { this.stopped = true; }}; sources.push(source); return source; },
  };
  const playback = new VoicePlayback(context, {...options, onState: s => states.push(s), onSpeaking: s => speaking.push(s)});
  return {playback, context, states, speaking, sources};
}
const job = {t_start: 10, t_end: 12};
test('holds audio until a real source clock mapping is available', t => {
  let offset = null;
  const x = setup({targetTime: j => offset === null ? null : j.t_start + offset}); t.after(() => x.playback.close());
  x.playback.enqueue(job, new Float32Array(24000)); assert.equal(x.sources.length, 0);
  offset = 91; x.playback.tick(); assert.equal(x.sources.length, 0);
  x.context.currentTime = 101; x.playback.tick(); assert.equal(x.sources[0].at, 101);
});
test('permits bounded Qwen delay but rechecks lateness after previous speech', t => {
  const x = setup({targetTime: () => 90, maxLateSeconds: 20}); t.after(() => x.playback.close());
  x.playback.enqueue(job, new Float32Array(24000)); assert.equal(x.states.at(-1).lateness, 10);
  x.playback.enqueue(job, new Float32Array(24000)); assert.equal(x.sources.length, 1);
  x.context.currentTime = 111; x.sources[0].onended(); assert.equal(x.sources.length, 1); assert.equal(x.states.at(-1).reason, 'late');
});
test('reset stops active speech, restores volume and prevents replay', t => {
  const x = setup({timing: 'as-ready'}); t.after(() => x.playback.close());
  x.playback.enqueue(job, new Float32Array(24000)); x.playback.enqueue(job, new Float32Array(24000));
  x.playback.reset(); x.playback.tick();
  assert.equal(x.sources[0].stopped, true); assert.equal(x.sources.length, 1); assert.equal(x.speaking.at(-1), false);
});
test('unlocked queues expire and are bounded', t => {
  let time = 0; const x = setup({now: () => time}); t.after(() => x.playback.close());
  for (let i = 0; i < 4; i++) x.playback.enqueue(job, new Float32Array(24000));
  assert.equal(x.playback.queue.length, 3); assert.equal(x.states.at(-1).reason, 'playback_queue_full');
  time = 46000; x.playback.tick(); assert.equal(x.playback.queue.length, 0);
});
