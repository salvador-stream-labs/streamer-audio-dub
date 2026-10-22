import {readFile, writeFile} from 'node:fs/promises';
import {config} from './config.mjs';
import {VoiceService} from './service.mjs';
import {VERSION} from '../src/voice/contract.js';
const [configPath, outputPath] = process.argv.slice(2);
if (!configPath || !outputPath) throw new Error('Usage: node native/smoke.mjs CONFIG_JSON OUTPUT_WAV');
const cfg = config(JSON.parse(await readFile(configPath, 'utf8')));
let service;
const blocks = [];
try {
  const result = await new Promise((resolve, reject) => {
    service = new VoiceService(cfg, m => {
      if (m.error) reject(new Error(m.error));
      else if (m.event === 'pcm') blocks.push(Buffer.from(m.data, 'base64'));
      else if (m.value) resolve(m.value);
    });
    service.receive({id: 'smoke', v: VERSION, type: 'speak', job: {
      session: 'local-smoke', utterance_id: '1', text: 'Thank you. Welcome to the stream.', language: 'en',
      t_start: 0, t_end: 4, prosody: null,
    }});
  });
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
