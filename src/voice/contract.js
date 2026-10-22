export const HOST = 'app.streamir.qwen';
export const VERSION = 'local_voice_v1';
export const MAX_TEXT = 1000;
export const MAX_AUDIO_SECONDS = 45;
export const VOICE_PACK_MAX_BYTES = 4194304;
export const VOICE_PART_BYTES = 16384;
export const VOICE_PART_CHARS = 21848;
export const VOICE_PARTS_MAX = 256;
export const LANGUAGES = {en: 'English', ru: 'Russian', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese', ja: 'Japanese', ko: 'Korean', zh: 'Chinese'};
export const ERRORS = {
  setup: 'Install the local Qwen helper and model, then reconnect.',
  busy: 'Local voice is already in use. Disconnect the other viewer first.',
  queue_full: 'The computer cannot keep up. This phrase was skipped.',
  expired: 'This phrase is too old and was skipped.',
  cancelled: 'Voice generation was cancelled.',
  timeout: 'Local voice generation took too long.',
  invalid: 'The viewer sent an unsupported voice request.',
  failed: 'Local voice generation failed. Check the helper configuration.',
  no_voice: 'Load the streamer voice first.',
  voice: 'The streamer voice could not be loaded.',
};
export function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('invalid');
}
export function text(value, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('invalid');
}
export function number(value, low, high) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) throw new Error('invalid');
}
export function job(value) {
  fields(value, ['session', 'utterance_id', 'text', 'language', 't_start', 't_end', 'prosody']);
  text(value.session); text(value.utterance_id); text(value.text, MAX_TEXT);
  if (!Object.hasOwn(LANGUAGES, value.language)) throw new Error('invalid');
  number(value.t_start, 0, Number.MAX_SAFE_INTEGER);
  number(value.t_end, value.t_start + 1 / 16000, Math.min(Number.MAX_SAFE_INTEGER, value.t_start + 30));
  number(value.t_end - value.t_start, 1 / 16000, 30);
  // Native validation additionally uses the pinned server Analysis parser.
  if (value.prosody !== null) {
    const p = value.prosody;
    if (!p || p.version !== 'source_prosody_v1' || p.session !== value.session ||
        p.utterance_id !== value.utterance_id || JSON.stringify(p).length > 8192) throw new Error('invalid');
  }
  return structuredClone(value);
}
export function request(value) {
  if (!value || value.v !== VERSION || typeof value.id !== 'string' || !/^[\w-]{1,64}$/.test(value.id)) throw new Error('invalid');
  if (value.type === 'speak') {
    fields(value, ['v', 'id', 'type', 'job']);
    return {...value, job: job(value.job)};
  }
  if (value.type === 'voice_load') {
    fields(value, ['v', 'id', 'type', 'grant', 'signature', 'size', 'sha256', 'parts']);
    const g = value.grant;
    if (!g || typeof g !== 'object' || Array.isArray(g) || g.v !== 'voice_grant_v1' || JSON.stringify(g).length > 4096 ||
        typeof value.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(value.signature) ||
        !Number.isInteger(value.size) || value.size < 1 || value.size > VOICE_PACK_MAX_BYTES ||
        typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256) ||
        value.parts !== Math.ceil(value.size / VOICE_PART_BYTES)) throw new Error('invalid');
    return structuredClone(value);
  }
  if (value.type === 'voice_part') {
    fields(value, ['v', 'id', 'type', 'load', 'index', 'data']);
    if (typeof value.load !== 'string' || !/^[\w-]{1,64}$/.test(value.load) ||
        !Number.isInteger(value.index) || value.index < 0 || value.index >= VOICE_PARTS_MAX ||
        typeof value.data !== 'string' || !value.data || value.data.length > VOICE_PART_CHARS ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) throw new Error('invalid');
    return {...value};
  }
  if (!['status', 'voice_identity', 'warmup', 'reset'].includes(value.type)) throw new Error('invalid');
  fields(value, ['v', 'id', 'type']);
  return {...value};
}
export function packParts(bytes) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += VOICE_PART_BYTES) parts.push(btoa(String.fromCharCode(...bytes.subarray(i, i + VOICE_PART_BYTES))));
  return parts;
}
export function allowedPage(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch { return false; }
}
