import {feedURL, parseFeed, FeedError} from './protocol.js';

// Probe the implemented feed rather than inventing a language catalogue.
// A hello advertises the sole language currently defined by feed_v1.
export function discoverFeed({origin, channel, WebSocketClass = globalThis.WebSocket, timeoutMs = 8000, signal}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const socket = new WebSocketClass(feedURL(origin, channel));
    let timer, finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(signal.reason ?? new FeedError('Discovery cancelled.'));
    signal?.addEventListener('abort', abort, {once: true});
    timer = setTimeout(() => finish(new FeedError('No feed greeting was announced for this channel.')), timeoutMs);
    socket.onerror = () => finish(new FeedError('Could not reach the channel feed.'));
    socket.onclose = () => finish(new FeedError('The channel feed is unavailable.'));
    socket.onmessage = event => {
      try {
        const message = parseFeed(event.data, channel);
        if (message.type !== 'hello') throw new FeedError('Expected a feed greeting.');
        finish(null, [{language: message.lang, label: 'English', channel, url: feedURL(origin, channel)}]);
      } catch (error) { finish(error); }
    };
  });
}

export class FeedClient {
  constructor({origin, channel, onMessage, onState, onReset = () => {},
    WebSocketClass = globalThis.WebSocket, random = Math.random, timeoutMs = 10000}) {
    Object.assign(this, {origin, channel, onMessage, onState, onReset, WebSocketClass, random, timeoutMs});
    this.generation = 0;
    this.attempt = 0;
    this.stopped = true;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    const generation = ++this.generation;
    const current = () => !this.stopped && generation === this.generation;
    this.onState({state: 'connecting'});
    let socket;
    try { socket = this.socket = new this.WebSocketClass(feedURL(this.origin, this.channel)); }
    catch (error) { this.stop(); this.onState({state: 'error', message: error.message}); return; }
    let greeted = false;
    this.helloTimer = setTimeout(() => {
      if (current() && !greeted) {
        this.onState({state: 'waiting', message: 'No feed greeting yet.'});
        socket.close(1000, 'No greeting');
      }
    }, this.timeoutMs);
    socket.onmessage = event => {
      if (!current()) return;
      try {
        const message = parseFeed(event.data, this.channel);
        if (message.type === 'hello') {
          greeted = true;
          this.attempt = 0;
          clearTimeout(this.helloTimer);
          // Every hello is a new synchronization boundary, including reconnects
          // with an unchanged epoch. The caller must clear old audio and hashes.
          this.onMessage(message);
          this.onState({state: 'connected', language: message.lang, producerLive: null});
        } else {
          if (!greeted) throw new FeedError('Feed sent data before its greeting.');
          this.onMessage(message);
        }
      } catch (error) {
        this.stop();
        this.onState({state: 'error', message: error.message});
      }
    };
    socket.onerror = () => { /* onclose owns retry, avoiding two connections. */ };
    socket.onclose = () => {
      if (!current()) return;
      clearTimeout(this.helloTimer);
      // Invalidate queued callbacks from the disconnected socket immediately.
      this.generation++;
      socket.onmessage = socket.onclose = socket.onerror = null;
      this.socket = null;
      this.onReset('disconnect');
      const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5)) * (0.8 + this.random() * 0.4);
      this.onState({state: 'reconnecting', retryMs: Math.round(delay)});
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }

  stop() {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.retryTimer);
    clearTimeout(this.helloTimer);
    if (this.socket) {
      this.socket.onmessage = this.socket.onclose = this.socket.onerror = null;
      this.socket.close();
      this.socket = null;
    }
    this.onReset('stop');
  }
}
