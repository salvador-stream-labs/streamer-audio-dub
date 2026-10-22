import {readFile} from 'node:fs/promises';
import {frame, decoder} from './protocol.mjs';
import {config as validateConfig} from './config.mjs';
import {VoiceService} from './service.mjs';

const saved = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (!/^[a-p]{32}$/.test(saved.extensionId) || process.argv[3] !== `chrome-extension://${saved.extensionId}/`) process.exit(1);
let closing = false;
const send = value => {
  if (closing) return;
  // Do not accumulate unbounded PCM if Chrome stops reading.
  if (process.stdout.writableLength > 1024 * 1024) { stop(); return; }
  process.stdout.write(frame(value));
};
const service = new VoiceService(validateConfig(saved.voice), send);
function stop() {
  if (closing) return;
  closing = true; service.close(); process.stdin.pause();
  // Allow the worker's SIGKILL/reap fallback to finish.
  setTimeout(() => process.exit(0), 1000);
}
for (const event of ['end', 'error']) process.stdin.on(event, stop);
process.stdout.on('error', stop);
process.on('SIGINT', stop); process.on('SIGTERM', stop);
const accept = decoder(message => service.receive(message));
process.stdin.on('data', chunk => { try { accept(chunk); } catch { stop(); } });
