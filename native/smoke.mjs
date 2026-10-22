import {readFile, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {config} from './config.mjs';
import {VoiceService} from './service.mjs';
import {VERSION, packParts} from '../src/voice/contract.js';
const args = process.argv.slice(2), positional = [];
let packPath, keyPath;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--pack') packPath = args[++i];
  else if (args[i] === '--key') keyPath = args[++i];
  else positional.push(args[i]);
}
const [configPath, outputPath] = positional;
if (!configPath || !outputPath || positional.length !== 2 || Boolean(packPath) !== Boolean(keyPath)) {
  throw new Error('Usage: node native/smoke.mjs CONFIG_JSON OUTPUT_WAV [--pack FILE --key FILE]');
}
const loaded = JSON.parse(await readFile(configPath, 'utf8'));
let signing;
if (packPath) {
  signing = JSON.parse(execFileSync(loaded.python, ['-I', fileURLToPath(new URL('pack.py', import.meta.url)), 'keygen'], {encoding: 'utf8'}));
  delete loaded.referenceAudio; delete loaded.referenceText;
  Object.assign(loaded, {voice: 'pack', voicePublicKeys: [signing.signing_public_b64url]});
}
const cfg = config(loaded);
let service, nextId = 0;
const blocks = [], waiting = new Map();
const call = (type, fields = {}, id = `smoke-${++nextId}`) => new Promise((resolve, reject) => {
  waiting.set(id, {resolve, reject});
  service.receive({id, v: VERSION, type, ...fields});
});
try {
  service = new VoiceService(cfg, m => {
    if (m.event === 'pcm') { blocks.push(Buffer.from(m.data, 'base64')); return; }
    const w = waiting.get(m.id);
    if (!w) return;
    if (m.error) { waiting.delete(m.id); w.reject(new Error(m.error)); }
    else if (m.value) { waiting.delete(m.id); w.resolve(m.value); }
  });
  if (packPath) {
    await call('warmup');
    const identity = await call('voice_identity');
    const header = JSON.parse(execFileSync(cfg.python, ['-I', fileURLToPath(new URL('pack.py', import.meta.url)), 'inspect', packPath], {encoding: 'utf8'}));
    const grant = JSON.parse(execFileSync(cfg.python, ['-I', fileURLToPath(new URL('pack.py', import.meta.url)), 'grant',
      '--signing-seed', signing.signing_seed_b64url, '--pack', packPath, '--key', keyPath, '--helper-public-key', identity.public_key,
      '--channel', header.channel, '--model-id', identity.model_id, '--pack-url', 'https://smoke.invalid/pack'], {encoding: 'utf8'}));
    const bytes = new Uint8Array(await readFile(packPath)), parts = packParts(bytes), id = 'smoke-load';
    const load = call('voice_load', {grant: grant.grant, signature: grant.signature, size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), parts: parts.length}, id);
    load.catch(() => {});
    for (let index = 0; index < parts.length; index++) await call('voice_part', {load: id, index, data: parts[index]});
    const voice = await load;
    if (voice.loaded !== true) throw new Error('Voice pack did not load');
    console.log(JSON.stringify(voice));
  }
  const result = await call('speak', {job: {
    session: 'local-smoke', utterance_id: '1', text: 'Thank you. Welcome to the stream.', language: 'en',
    t_start: 0, t_end: 4, prosody: null,
  }});
  const pcm = Buffer.concat(blocks);
  if (!pcm.length || pcm.length !== result.samples * 2) throw new Error('Incomplete PCM');
  const wav = Buffer.alloc(44);
  wav.write('RIFF'); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40);
  await writeFile(outputPath, Buffer.concat([wav, pcm]));
  console.log(JSON.stringify(result));
} finally { service?.close(); }
