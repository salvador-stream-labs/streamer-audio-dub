import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFeed, channelFromURL, serverOrigin, feedURL, MAX_MESSAGE_BYTES} from '../src/feed/protocol.js';
import {discoverFeed, FeedClient} from '../src/feed/client.js';

const hello = {type: 'hello', v: 'feed_v1', channel: 'hexxyi', clock_epoch: '2026-10-20T12:00:00.000Z', lang: 'en'};
const say = {type: 'say', v: 'feed_v1', seq: 1, t_start: 0, t_end: 2, text_en: 'Hello', audio: {codec: 'ogg/opus', data: 'T2dnUw=='}};
const {audio, ...captionFields} = say;
const caption = {...captionFields, type: 'caption'};
const parse = value => parseFeed(JSON.stringify(value), 'hexxyi');

test('accepts all four feed events, including independent captions and unchanged utt_v1 fingerprints', () => {
  assert.deepEqual(parse(hello), hello);
  assert.deepEqual(parse(say), say);
  assert.deepEqual(parse(caption), caption);
  assert.deepEqual(parse({type: 'fp', v: 'utt_v1', hashes: []}).hashes, []);
  const fp = {type: 'fp', v: 'utt_v1', hashes: [[0xffffffff, 1.25]]};
  assert.deepEqual(parse(fp), fp);
  assert.throws(() => parse({...fp, v: 'feed_v1'}), /version/);
});

test('rejects missing/extra fields at both message and audio levels and unknown types/versions', () => {
  const fp = {type: 'fp', v: 'utt_v1', hashes: []};
  for (const message of [hello, caption, say, fp]) {
    assert.throws(() => parse({...message, extra: true}), /fields/);
    for (const key of Object.keys(message)) {
      const missing = {...message}; delete missing[key];
      assert.throws(() => parse(missing));
    }
    assert.throws(() => parse({...message, v: 'feed_v2'}), /version/);
  }
  assert.throws(() => parse({...say, audio: {...say.audio, duration: 2}}), /audio/);
  assert.throws(() => parse({...caption, audio: say.audio}), /fields/);
  for (const type of ['unknown', '__proto__', ['caption'], null]) assert.throws(() => parse({...caption, type}));
});

test('consumer size and integer limits reject whole events without truncating', () => {
  assert.equal(parse({...caption, seq: Number.MAX_SAFE_INTEGER}).seq, Number.MAX_SAFE_INTEGER);
  assert.throws(() => parse({...caption, seq: Number.MAX_SAFE_INTEGER + 1}));
  assert.equal(parse({...caption, text_en: '🙂'.repeat(5000)}).text_en.length, 10000);
  assert.throws(() => parse({...caption, text_en: '🙂'.repeat(5001)}));
  assert.equal(parse({type: 'fp', v: 'utt_v1', hashes: Array.from({length: 20000}, () => [1, 0])}).hashes.length, 20000);
  assert.throws(() => parse({type: 'fp', v: 'utt_v1', hashes: Array.from({length: 20001}, () => [1, 0])}));
  const serialized = JSON.stringify(hello);
  assert.deepEqual(parseFeed(serialized.padEnd(MAX_MESSAGE_BYTES), 'hexxyi'), hello);
  assert.throws(() => parseFeed(serialized.padEnd(MAX_MESSAGE_BYTES + 1), 'hexxyi'), /large/);
  assert.equal(parse({...say, audio: {...say.audio, data: 'AAAA'.repeat(300000)}}).audio.data.length, 1200000);
});

test('rejects wrong channels, unsupported languages, invalid timestamps and audio', () => {
  for (const message of [
    {...hello, channel: 'other'}, {...hello, lang: 'fr'}, {...hello, clock_epoch: '2026-10-20'},
    {...hello, clock_epoch: '2026-02-30T00:00:00Z'}, {...hello, clock_epoch: '2026-10-20T24:00:00Z'},
    {...say, t_end: 31}, {...say, seq: -1}, {...say, seq: 1.1},
    {...say, audio: {codec: 'pcm16', data: 'T2dnUw=='}},
    {...say, audio: {codec: 'ogg/opus', data: '*bad*'}},
    {type: 'fp', v: 'utt_v1', hashes: [[1, -1]]},
  ]) assert.throws(() => parse(message));
});

test('only identifies Twitch live-channel pages and validates the server origin', () => {
  assert.equal(channelFromURL('https://www.twitch.tv/Hexxyi?ref=test'), 'hexxyi');
  for (const url of ['https://www.twitch.tv/directory', 'https://www.twitch.tv/videos/123', 'https://evil.test/hexxyi']) {
    assert.equal(channelFromURL(url), null);
  }
  assert.equal(feedURL('https://server.streamir.app', 'hexxyi'), 'wss://server.streamir.app/feed/hexxyi');
  assert.equal(feedURL('http://127.0.0.1:8765', 'hexxyi'), 'ws://127.0.0.1:8765/feed/hexxyi');
  assert.throws(() => serverOrigin('http://example.com'));
  assert.throws(() => serverOrigin('https://user:secret@example.com'));
  assert.throws(() => serverOrigin('https://example.com/feed'));
});

class Socket {
  static instances = [];
  constructor(url) { this.url = url; Socket.instances.push(this); }
  close() { this.closed = true; }
  emit(value) { this.onmessage?.({data: JSON.stringify(value)}); }
}

test('discovery advertises only the language the server actually announces', async () => {
  const discovery = discoverFeed({origin: 'https://server.streamir.app', channel: 'hexxyi', WebSocketClass: Socket});
  const socket = Socket.instances.at(-1);
  socket.emit(hello);
  assert.deepEqual((await discovery).map(item => item.language), ['en']);
  assert.equal(socket.closed, true);
});

test('discovery abort closes the connection', async () => {
  const controller = new AbortController();
  const pending = discoverFeed({channel: 'hexxyi', WebSocketClass: Socket, signal: controller.signal});
  controller.abort();
  await assert.rejects(pending, /abort/i);
  assert.equal(Socket.instances.at(-1).closed, true);
});

test('client delivers every hello as a reset boundary and rejects data before hello', () => {
  const messages = [], states = [];
  const client = new FeedClient({channel: 'hexxyi', WebSocketClass: Socket, onMessage: m => messages.push(m), onState: s => states.push(s)});
  client.start();
  const socket = Socket.instances.at(-1);
  socket.emit(hello); socket.emit(say); socket.emit(hello);
  assert.deepEqual(messages.map(m => m.type), ['hello', 'say', 'hello']);
  assert.equal(states.at(-1).producerLive, null, 'Cached hello cannot prove a producer is live');
  client.stop();
  assert.equal(socket.closed, true);
  const bad = new FeedClient({channel: 'hexxyi', WebSocketClass: Socket, onMessage: () => assert.fail('premature delivery'), onState: s => states.push(s)});
  bad.start();
  Socket.instances.at(-1).emit(say);
  assert.equal(states.at(-1).state, 'error');
  assert.equal(Socket.instances.at(-1).closed, true);
});

test('disconnect clears the timeline immediately and rejects queued messages from the old socket', () => {
  const messages = [], resets = [], states = [];
  const client = new FeedClient({channel: 'hexxyi', WebSocketClass: Socket,
    onMessage: m => messages.push(m), onReset: r => resets.push(r), onState: s => states.push(s)});
  client.start();
  const socket = Socket.instances.at(-1);
  socket.emit(hello);
  const stale = socket.onmessage;
  socket.onclose();
  stale({data: JSON.stringify(caption)});
  assert.deepEqual(resets, ['disconnect']);
  assert.deepEqual(messages.map(m => m.type), ['hello']);
  assert.equal(states.at(-1).state, 'reconnecting');
  client.stop();
});

test('a channel without a greeting gets a bounded waiting result', async () => {
  const states = [];
  const client = new FeedClient({channel: 'hexxyi', WebSocketClass: Socket, timeoutMs: 5,
    onMessage: () => {}, onState: s => states.push(s)});
  client.start();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(states.at(-1).state, 'waiting');
  assert.equal(Socket.instances.at(-1).closed, true);
  client.stop();
});
