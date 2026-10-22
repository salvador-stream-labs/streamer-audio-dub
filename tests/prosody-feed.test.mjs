import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {ProsodyFeed} from '../page/prosody-feed.js';
import {config} from '../native/config.mjs';

const frames = JSON.parse(readFileSync(new URL('fixtures/prosody-feed-v3.json', import.meta.url)));
const raw = JSON.stringify;
function fixture(options = {}) {
  const jobs = [], states = [], resets = [];
  const voice = {reset: async () => {resets.push(true);}, speak: async job => {jobs.push(job);}};
  return {jobs, states, resets, feed: new ProsodyFeed({voice, channel: 'demo', onState: s => states.push(s), ...options})};
}
test('server fixture connects neutral first and expressive second to the same helper session', async () => {
  const {feed, jobs, resets} = fixture();
  for (const frame of frames) await feed.accept(raw(frame));
  assert.equal(resets.length, 1);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].prosody, null);
  assert.equal(jobs[0].session, jobs[1].session);
  assert.deepEqual(jobs[1].prosody, frames[2].analysis);
  assert.equal(feed.url('wss://example.com/'), 'wss://example.com/feed/demo?v=feed_v3&lang=en&prosody=1');
});
test('late results do not replay speech and the map has count and age bounds', async () => {
  let time = 0;
  const {feed, jobs, states} = fixture({now: () => time});
  await feed.accept(raw(frames[0]));
  await feed.accept(raw(frames[3]));
  feed.accept(raw(frames[2]));
  assert.equal(jobs.length, 1); assert.equal(jobs[0].prosody, null);
  assert.equal(states.at(-1).reason, 'late');
  for (let seq = 3; seq < 100; seq++) feed.accept(raw({...frames[2], seq, analysis: {...frames[2].analysis, utterance_id: String(seq)}}));
  assert.equal(feed.pending.size, 64);
  time = 30001;
  await feed.accept(raw({...frames[3], seq: 100}));
  assert.equal(feed.pending.size, 0);
});
test('same-epoch hello clears matches and queued dispatches; stale source identity is ignored', async () => {
  const {feed, jobs} = fixture();
  await feed.accept(raw(frames[0]));
  feed.accept(raw(frames[2]));
  const pending = feed.accept(raw(frames[3]));
  const changed = {...frames[0], analysis_session: 'new-session'};
  await feed.accept(raw(changed)); await pending;
  assert.equal(jobs.length, 0);
  feed.accept(raw(frames[2]));
  await feed.accept(raw(frames[3]));
  assert.equal(jobs[0].session, 'new-session'); assert.equal(jobs[0].prosody, null);
  await feed.reset();
  assert.throws(() => feed.accept(raw(frames[3])));
});
test('local mode ignores server speech and needs an explicit speaker on multi-speaker feeds', async () => {
  const {feed, jobs} = fixture();
  await feed.accept(raw({...frames[0], speakers: [{id: 'a', label: 'A'}, {id: 'b', label: 'B'}]}));
  await feed.accept(raw(frames[3]));
  assert.equal(jobs.length, 0);
  feed.speakerId = 'a';
  await feed.accept(raw({...frames[3], seq: 3, speaker_id: 'b'}));
  await feed.accept(raw({...frames[3], seq: 4, speaker_id: 'a'}));
  await feed.accept(raw({...frames[3], type: 'say', seq: 4, audio: {}}));
  assert.equal(jobs.length, 1);
});
test('strict negotiation rejects unknown fields and identities before dispatch', async () => {
  const {feed} = fixture();
  for (const m of [{...frames[0], extra: 1}, {...frames[0], channel: 'other'}, {...frames[0], analysis_session: ''}]) {
    assert.throws(() => feed.accept(raw(m)));
  }
  await feed.accept(raw(frames[0]));
  for (const m of [{...frames[2], seq: 3}, {...frames[2], extra: 1}, {...frames[3], type: 'unexpected'}]) {
    assert.throws(() => feed.accept(raw(m)));
  }
});
test('operator pitch cap is finite and bounded; page jobs cannot set it', () => {
  const base = {python: '/python', modelPath: '/model', backend: 'mlx', device: 'metal', mode: 'custom_voice', speaker: 'Ryan'};
  for (const cap of [0, .5, 1]) assert.equal(config({...base, pitchCapSemitones: cap}).pitchCapSemitones, cap);
  for (const cap of [-1, 1.1, 3, NaN, Infinity, true, '1']) assert.throws(() => config({...base, pitchCapSemitones: cap}));
});
