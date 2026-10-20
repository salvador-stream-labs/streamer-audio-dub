import test from 'node:test';
import assert from 'node:assert/strict';
import {FeedSession} from '../src/feed/session.js';
import {FeedScheduler} from '../src/audio/scheduler.js';

const hello = {type: 'hello', v: 'feed_v1', channel: 'hexxyi', clock_epoch: '2026-10-20T12:00:00Z', lang: 'en'};
const caption = (seq = 1, start = 10, end = 12) => ({type: 'caption', v: 'feed_v1', seq, t_start: start, t_end: end, text_en: `Caption ${seq}`});
const say = (seq = 1, start = 10, end = 12) => ({...caption(seq, start, end), type: 'say', audio: {codec: 'ogg/opus', data: 'T2dnUw=='}});
const flush = () => new Promise(resolve => setImmediate(resolve));
class Socket {
  static instances = [];
  constructor(url) { this.url = url; Socket.instances.push(this); }
  emit(message) { this.onmessage?.({data: JSON.stringify(message)}); }
  close() { this.closed = true; }
}
function fixture(t, limits = {}) {
  const state = {time: 111, caption: null, played: [], resets: [], jobs: [], dropped: [], restored: 0, fingerprints: []};
  const scheduler = new FeedScheduler({
    now: () => state.time,
    showCaption: value => { state.caption = value; }, clearCaption: () => { state.caption = null; },
    restoreGain: () => { state.restored++; },
    onDrop: (...args) => state.dropped.push(args),
    play: (entry, at, ended) => {
      const item = {seq: entry.sentence.seq, at, ended, stopped: false};
      state.played.push(item); return () => { item.stopped = true; };
    },
  });
  const session = new FeedSession({
    channel: 'hexxyi', WebSocketClass: Socket, scheduler, ...limits,
    decode: (audio, {signal}) => new Promise((resolve, reject) => state.jobs.push({audio, signal, resolve, reject})),
    onReset: value => state.resets.push(value), onDrop: (...args) => state.dropped.push(args),
    onFingerprints: (hashes, generation) => state.fingerprints.push({hashes, generation}),
  });
  session.start();
  t.after(() => session.stop());
  const socket = Socket.instances.at(-1);
  socket.emit(hello);
  session.setLock(true, 100);
  return {session, socket, scheduler, state};
}

test('orphan say shows caption on receipt, before decode, even when decoding fails', async t => {
  const {session, socket, state} = fixture(t);
  socket.emit(say());
  assert.equal(state.caption.seq, 1);
  assert.equal(state.played.length, 0);
  await flush(); state.jobs[0].reject(new Error('Invalid Ogg'));
  await flush();
  assert.equal(state.caption.seq, 1);
  assert.deepEqual(state.dropped, [[1, 'decode', 'say']]);
  state.time = 112; session.tick();
  assert.equal(state.caption, null);
});

test('decode lateness drops audio without reviving its expired caption', async t => {
  const {session, socket, state} = fixture(t);
  socket.emit(caption()); socket.emit(say()); socket.emit(say());
  await flush(); assert.equal(state.jobs.length, 1);
  state.time = 116; session.tick();
  state.jobs[0].resolve({duration: 1});
  await flush();
  assert.equal(state.played.length, 0);
  assert.equal(state.caption, null);
  assert.deepEqual(state.dropped, [[1, 'late', 'say']]);
});

test('every hello resets identity even with the same epoch; stale decodes and matcher results are ignored', async t => {
  const {session, socket, state} = fixture(t);
  const generation = session.syncGeneration;
  socket.emit(say(7)); await flush();
  socket.emit(hello);
  assert.equal(state.jobs[0].signal.aborted, true);
  assert.equal(state.caption, null);
  assert.equal(session.setLock(true, 100, generation), false);
  state.jobs[0].resolve({duration: 2}); await flush();
  assert.equal(state.played.length, 0);
  session.setLock(true, 100);
  socket.emit(say(7)); await flush();
  state.jobs[1].resolve({duration: 2}); await flush();
  assert.equal(state.played[0].seq, 7);
  assert.equal(state.resets.filter(r => r.reason === 'hello').length, 2);
});

test('disconnect stops playback, clears captions/lock and suppresses late decode and ended callbacks', async t => {
  const {socket, scheduler, state} = fixture(t);
  socket.emit(say(1)); await flush(); state.jobs[0].resolve({duration: 3}); await flush();
  socket.emit(say(2)); await flush();
  socket.onclose();
  assert.equal(state.played[0].stopped, true);
  assert.equal(state.caption, null);
  assert.equal(scheduler.locked, false);
  state.jobs[1].resolve({duration: 3});
  state.played[0].ended(); await flush();
  assert.equal(state.played.length, 1);
  assert.equal(state.resets.at(-1).reason, 'disconnect');
});

test('channel changes reject old decodes; new channel data waits for its own hello', async t => {
  const {session, socket, state} = fixture(t);
  socket.emit(say()); await flush();
  session.setChannel('another');
  const next = Socket.instances.at(-1);
  assert.ok(next.url.endsWith('/feed/another'));
  assert.equal(socket.closed, true);
  state.jobs[0].resolve({duration: 3}); await flush();
  assert.equal(state.played.length, 0);
  next.emit({...hello, channel: 'another'});
  session.setLock(true, 100);
  next.emit(caption(1));
  assert.equal(state.caption.seq, 1);
});

test('decode pressure is bounded across resets and never blocks incoming captions', async t => {
  const {session, socket, state} = fixture(t, {maxDecodes: 1, maxPending: 1});
  socket.emit(say(1)); socket.emit(say(2)); socket.emit(say(3));
  await flush();
  assert.equal(state.jobs.length, 1); assert.equal(session.waiting.length, 1);
  assert.equal(state.caption.seq, 3);
  assert.ok(state.dropped.some(([seq, reason]) => seq === 3 && reason === 'decode-overflow'));
  socket.emit(hello); session.setLock(true, 100);
  socket.emit(say(4)); socket.emit(caption(5));
  await flush(); assert.equal(state.jobs.length, 1);
  assert.equal(state.caption.seq, 5);
  state.jobs[0].resolve({duration: 2}); await flush();
  assert.equal(state.jobs.length, 2);
  assert.equal(state.played.length, 0, 'Old generation never plays');
  state.jobs[1].resolve({duration: 2}); await flush();
  assert.equal(state.played[0].seq, 4);
});

test('pause, seek and ad invalidation reject stale matcher results while retaining unstarted events', async t => {
  const {session, socket, state} = fixture(t);
  socket.emit({type: 'fp', v: 'utt_v1', hashes: [[123, 10]]});
  const old = state.fingerprints[0].generation;
  socket.emit(say()); await flush();
  session.setRunning(false);
  state.jobs[0].resolve({duration: 2}); await flush();
  session.setRunning(true);
  assert.equal(session.setLock(true, 100, old), false);
  assert.equal(state.played.length, 0);
  session.setLock(true, 100);
  assert.equal(state.played.length, 1);
  for (const reason of ['seek', 'ad', 'player-replaced']) {
    const generation = session.syncGeneration;
    session.invalidatePlayback(reason);
    assert.equal(session.setLock(true, 100, generation), false);
    session.setLock(true, 100);
  }
  assert.equal(state.played.length, 1, 'Interrupted speech cannot replay');
});
