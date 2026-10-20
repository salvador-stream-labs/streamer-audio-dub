import test from 'node:test';
import assert from 'node:assert/strict';
import {FeedScheduler} from '../src/audio/scheduler.js';

function fixture(options = {}) {
  const state = {time: 10, played: [], dropped: [], cleared: 0, shown: [], caption: null, restored: 0};
  const scheduler = new FeedScheduler({
    now: () => state.time,
    play: (entry, at, ended) => {
      const item = {seq: entry.sentence.seq, at, ended, stopped: false};
      state.played.push(item);
      return () => { item.stopped = true; };
    },
    showCaption: caption => { state.shown.push(caption.seq); state.caption = caption; },
    clearCaption: () => { state.cleared++; state.caption = null; },
    restoreGain: () => { state.restored++; },
    onDrop: seq => state.dropped.push(seq),
    ...options,
  });
  const enqueue = (seq, start) => scheduler.enqueue({seq, t_start: start, t_end: start + 2, text_en: String(seq)}, {});
  return {scheduler, state, enqueue};
}

test('holds speech without a fingerprint lock and schedules in AudioContext time', () => {
  const {scheduler, state} = fixture();
  const sentence = {seq: 1, t_start: 10, t_end: 12, text_en: 'Hello'};
  state.time = 107; scheduler.enqueueCaption(sentence);
  state.time = 109; scheduler.enqueue(sentence, {});
  assert.equal(state.played.length, 0);
  state.time = 109.9; scheduler.setLock(true, 100);
  assert.equal(state.played[0].at, 110);
  assert.equal(state.caption, null);
  state.time = 110; scheduler.tick();
  assert.equal(state.caption.seq, 1);
  state.time = 112; scheduler.tick();
  assert.equal(state.caption, null);
  assert.equal(state.played[0].stopped, false, 'Caption end does not end the decoded buffer');
});

const caption = (seq = 1, start = 10, end = 12) => ({seq, t_start: start, t_end: end, text_en: `Caption ${seq}`});
test('contract example: captions display 110–112 even when speech becomes ready at 114', () => {
  const {scheduler, state} = fixture();
  state.time = 107; scheduler.setLock(true, 100);
  scheduler.enqueueCaption(caption());
  assert.equal(state.caption, null);
  state.time = 110; scheduler.tick();
  assert.equal(state.caption.seq, 1);
  state.time = 112; scheduler.tick();
  assert.equal(state.caption, null);
  state.time = 114; scheduler.enqueue(caption(), {});
  assert.equal(state.played[0].at, 114);
  assert.equal(state.caption, null);
  assert.deepEqual(state.shown, [1], 'Late audio never restarts the caption');
});

test('partly elapsed captions use remaining source time and expired orphan captions stay hidden', () => {
  const {scheduler, state} = fixture();
  state.time = 111; scheduler.setLock(true, 100);
  scheduler.enqueueCaption(caption());
  assert.equal(state.caption.seq, 1);
  state.time = 112; scheduler.tick();
  assert.equal(state.caption, null);
  state.time = 114; scheduler.enqueue(caption(2), {});
  assert.equal(state.played[0].seq, 2);
  assert.equal(state.caption, null);
});

test('early speech completion does not clear captions, and captions can hide while speech continues', () => {
  const {scheduler, state} = fixture();
  state.time = 110; scheduler.setLock(true, 100);
  scheduler.enqueue(caption(), {});
  state.time = 110.5; state.played[0].ended();
  assert.equal(state.caption.seq, 1);
  scheduler.setCaptionsVisible(false);
  assert.equal(state.caption, null);
  state.time = 111; scheduler.setCaptionsVisible(true);
  assert.equal(state.caption.seq, 1);
  scheduler.setCaptionsVisible(false);
  state.time = 112; scheduler.setCaptionsVisible(true);
  assert.equal(state.caption, null);
  assert.equal(state.played.length, 1);
  assert.equal(state.played[0].stopped, false);
});

test('interleaved sequences are deduplicated independently with no global high-water mark', () => {
  const {scheduler, state} = fixture();
  scheduler.enqueueCaption(caption(100, 20, 22));
  scheduler.enqueue(caption(9, 10, 12), {});
  scheduler.enqueue(caption(4, 8, 10), {});
  assert.equal(scheduler.enqueue(caption(9, 10, 12), {}), false);
  assert.equal(scheduler.enqueueCaption(caption(4, 8, 10)), false);
  state.time = 110; scheduler.setLock(true, 100);
  assert.equal(state.played[0].seq, 4);
  state.played[0].ended();
  assert.equal(state.played[1].seq, 9);
  assert.equal(state.caption.seq, 9);
  assert.deepEqual(state.shown, [9]);
});

test('freshness is checked after waiting for another dub, including the exact five-second boundary', () => {
  const {scheduler, state} = fixture();
  state.time = 110; scheduler.setLock(true, 100);
  scheduler.enqueue(caption(1), {});
  scheduler.enqueue(caption(2, 10, 12), {});
  scheduler.enqueue(caption(3, 11, 13), {});
  state.time = 116; state.played[0].ended();
  assert.deepEqual(state.dropped, [2]);
  assert.equal(state.played[1].seq, 3);
  assert.equal(state.played[1].at, 116);
  assert.equal(state.caption, null);
});

test('interrupted started speech never restarts on immediate relock', () => {
  const {scheduler, state} = fixture();
  state.time = 110; scheduler.setLock(true, 100);
  scheduler.enqueue(caption(), {});
  state.time = 110.5; scheduler.setLock(false);
  assert.equal(state.played[0].stopped, true);
  assert.equal(state.caption, null);
  scheduler.setLock(true, 100);
  assert.equal(state.played.length, 1);
  assert.deepEqual(state.dropped, [1]);
  assert.ok(state.restored >= 2);
});

test('unstarted scheduled speech survives lock loss, and old completion cannot disturb replacement', () => {
  const {scheduler, state} = fixture();
  state.time = 109.9; scheduler.setLock(true, 100);
  scheduler.enqueue(caption(), {});
  assert.equal(state.played[0].at, 110);
  scheduler.setLock(false);
  scheduler.setLock(true, 100);
  assert.equal(state.played.length, 2);
  state.played[0].ended();
  assert.equal(scheduler.active.entry.sentence.seq, 1);
  state.time = 110; scheduler.tick();
  assert.equal(state.caption.seq, 1);
});

test('pause and offset discontinuity cancel audio and require a fresh timing decision', () => {
  const {scheduler, state} = fixture();
  state.time = 110; scheduler.setLock(true, 100);
  scheduler.enqueue(caption(1), {});
  scheduler.setRunning(false);
  scheduler.enqueue(caption(2, 11, 13), {});
  scheduler.setRunning(true);
  assert.equal(state.played.length, 1);
  state.time = 111; scheduler.setLock(true, 100);
  assert.equal(state.played.length, 2);
  scheduler.setLock(true, 101);
  assert.equal(state.played[1].stopped, true);
  assert.equal(state.played.length, 2);
});

test('speech overflow cannot block captions, and unlocked caption queues remain bounded', () => {
  const {scheduler, state} = fixture({maxSpeech: 1, maxCaptions: 2});
  scheduler.enqueue(caption(1, 5, 6), {});
  assert.equal(scheduler.enqueue(caption(2, 10, 12), {}), false);
  scheduler.enqueueCaption(caption(3, 12, 14));
  assert.equal(scheduler.pending.length, 1);
  assert.equal(scheduler.captions.size, 2);
  state.time = 110; scheduler.setLock(true, 100);
  assert.equal(state.caption.seq, 2);
  assert.ok(state.dropped.includes(2), 'Speech dropped, caption retained');
});

test('late audio starts immediately; only sentences over five seconds late are dropped', () => {
  const {scheduler, state, enqueue} = fixture();
  enqueue(1, 0); enqueue(2, 3);
  scheduler.setLock(true, 2);
  assert.deepEqual(state.dropped, [1]);
  assert.equal(state.played[0].seq, 2);
  assert.equal(state.played[0].at, 10);
});

test('future sentences stay cancellable and consecutive speech does not overlap', () => {
  const {scheduler, state, enqueue} = fixture();
  scheduler.setLock(true, 10);
  enqueue(1, 2); enqueue(2, 2.2);
  assert.equal(state.played.length, 0);
  state.time = 12;
  scheduler.tick();
  assert.equal(state.played.length, 1);
  state.time = 13;
  state.played[0].ended();
  assert.equal(state.played[1].at, 13);
});

test('lock loss cancels playback, clears captions and trims stale speech on relock', () => {
  const {scheduler, state, enqueue} = fixture();
  scheduler.setLock(true, 10);
  enqueue(1, 0);
  scheduler.setLock(false);
  assert.equal(state.played[0].stopped, true);
  const count = state.played.length;
  state.time = 16;
  scheduler.setLock(true, 10);
  assert.equal(state.played.length, count);
  assert.deepEqual(state.dropped, [1]);
});

test('epoch reset discards old audio and permits server sequence restart', () => {
  const {scheduler, state, enqueue} = fixture();
  scheduler.setLock(true, 10);
  enqueue(5, 0);
  scheduler.reset();
  assert.equal(state.played[0].stopped, true);
  assert.equal(enqueue(1, 0), true);
  assert.equal(state.played.length, 1);
  assert.equal(enqueue(1, 0), false);
});
