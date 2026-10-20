// The sibling server owns feed_v1. Fingerprints retain utt_v1 when relayed.
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
// Historical name: the limit is UTF-16 code units (raw.length), not UTF-8 bytes.

export class FeedError extends Error {}

function requireValue(valid, reason) {
  if (!valid) throw new FeedError(reason);
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const text = (value, limit) => typeof value === 'string' && Boolean(value.trim()) && value.length <= limit;
const fields = (value, keys) => object(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const messageFields = {
  hello: ['type', 'v', 'channel', 'clock_epoch', 'lang'],
  caption: ['type', 'v', 'seq', 't_start', 't_end', 'text_en'],
  say: ['type', 'v', 'seq', 't_start', 't_end', 'text_en', 'audio'],
  fp: ['type', 'v', 'hashes'],
};
function validEpoch(value) {
  if (typeof value !== 'string' || !/T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))) return false;
  // Date.parse normalizes impossible dates such as February 30 and 24:00.
  // The server's datetime validator rejects those; do not accept that rollover.
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/.exec(value);
  if (!parts) return false;
  const [, year, month, day, hour] = parts.map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour < 24;
}

export function channelFromURL(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://www.twitch.tv') return null;
    const match = url.pathname.match(/^\/([a-z0-9_]{1,25})\/?$/i);
    if (!match || /^(directory|downloads|settings|subscriptions|inventory|wallet|jobs|search|videos|friends|messages)$/i.test(match[1])) return null;
    return match[1].toLowerCase();
  } catch { return null; }
}

export function serverOrigin(value = 'https://server.streamir.app') {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  requireValue(url.protocol === 'https:' || (local && url.protocol === 'http:'), 'Use HTTPS, or HTTP on localhost.');
  requireValue(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
    'Enter the server origin without a path or credentials.');
  return url.origin;
}

export function feedURL(origin, channel) {
  requireValue(typeof channel === 'string' && /^[a-z0-9_]{1,25}$/.test(channel), 'Invalid Twitch channel.');
  const url = new URL(`/feed/${channel}`, serverOrigin(origin));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

export function parseFeed(raw, expectedChannel) {
  requireValue(typeof raw === 'string' && raw.length <= MAX_MESSAGE_BYTES, 'Feed message is too large or is not text.');
  let message;
  try { message = JSON.parse(raw); } catch { throw new FeedError('Invalid feed JSON.'); }
  requireValue(object(message), 'Invalid feed object.');
  const {type, v} = message;
  requireValue(typeof type === 'string' && Object.hasOwn(messageFields, type), 'Unknown feed message type.');
  requireValue(fields(message, messageFields[type]), 'Unexpected or missing feed fields.');
  requireValue(v === (type === 'fp' ? 'utt_v1' : 'feed_v1'), 'Unsupported feed version.');
  if (type === 'hello') {
    requireValue(message.channel === expectedChannel, 'Feed belongs to another channel.');
    requireValue(message.lang === 'en', 'feed_v1 only defines English output.');
    requireValue(validEpoch(message.clock_epoch), 'Invalid feed clock epoch.');
    return {type, v, channel: message.channel, lang: message.lang, clock_epoch: message.clock_epoch};
  }
  if (type === 'fp') {
    requireValue(Array.isArray(message.hashes) && message.hashes.length <= 20000, 'Invalid fingerprint batch.');
    for (const pair of message.hashes) {
      requireValue(Array.isArray(pair) && pair.length === 2 &&
        Number.isInteger(pair[0]) && pair[0] >= 0 && pair[0] <= 0xffffffff &&
        finite(pair[1]) && pair[1] >= 0, 'Invalid fingerprint landmark.');
    }
    return {type, v, hashes: message.hashes};
  }
  requireValue(Number.isSafeInteger(message.seq) && message.seq >= 0, 'Invalid sentence sequence.');
  requireValue(finite(message.t_start) && finite(message.t_end) && message.t_start >= 0 &&
    message.t_end - message.t_start >= 1 / 16000 && message.t_end - message.t_start <= 30,
  'Invalid sentence time span.');
  requireValue(text(message.text_en, 10000), 'Invalid caption text.');
  const sentence = {type, v, seq: message.seq, t_start: message.t_start, t_end: message.t_end, text_en: message.text_en};
  if (type === 'caption') return sentence;
  requireValue(fields(message.audio, ['codec', 'data']) && message.audio.codec === 'ogg/opus' &&
    text(message.audio.data, MAX_MESSAGE_BYTES) &&
    message.audio.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(message.audio.data),
  'Invalid Ogg/Opus audio.');
  return {
    ...sentence, audio: {codec: 'ogg/opus', data: message.audio.data},
  };
}
