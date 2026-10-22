export const HOST = 'app.streamir.qwen';
export const VERSION = 'local_voice_v1';
export const MAX_TEXT = 1000;
export const MAX_AUDIO_SECONDS = 45;
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
  if (!['status', 'warmup', 'reset'].includes(value.type)) throw new Error('invalid');
  fields(value, ['v', 'id', 'type']);
  return {...value};
}
export function allowedPage(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch { return false; }
}
