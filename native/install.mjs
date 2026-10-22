import {mkdir, readFile, writeFile, chmod, access} from 'node:fs/promises';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {HOST} from '../src/voice/contract.js';
import {config as validateConfig} from './config.mjs';
const [extensionId, configPath] = process.argv.slice(2);
if (!/^[a-p]{32}$/.test(extensionId ?? '') || !configPath) throw new Error('Usage: node native/install.mjs EXTENSION_ID /path/to/voice-config.json');
if (!['darwin', 'linux'].includes(process.platform)) throw new Error('This installer currently supports macOS and Linux.');
const voice = validateConfig(JSON.parse(await readFile(configPath, 'utf8')));
await access(voice.python); await access(path.join(voice.modelPath, 'config.json'));
if (voice.referenceAudio) await access(voice.referenceAudio);
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = process.env.STREAMIR_INSTALL_ROOT
  ? path.resolve(process.env.STREAMIR_INSTALL_ROOT, 'state', extensionId)
  : path.join(homedir(), '.config', 'streamir-qwen', extensionId);
const manifests = process.env.STREAMIR_INSTALL_ROOT
  ? path.resolve(process.env.STREAMIR_INSTALL_ROOT, 'NativeMessagingHosts')
  : process.platform === 'darwin'
    ? path.join(homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts')
    : path.join(homedir(), '.config/google-chrome/NativeMessagingHosts');
await mkdir(directory, {recursive: true, mode: 0o700}); await chmod(directory, 0o700);
await mkdir(manifests, {recursive: true});
const config = path.join(directory, 'host.json');
await writeFile(config, JSON.stringify({extensionId, voice}), {mode: 0o600}); await chmod(config, 0o600);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const launcher = path.join(directory, 'launch.sh');
await writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, 'native/host.mjs'))} ${quote(config)} "$@"\n`, {mode: 0o700});
await chmod(launcher, 0o700);
await writeFile(path.join(manifests, `${HOST}.json`), JSON.stringify({
  name: HOST, description: 'Streamir local Qwen voice generation', path: launcher, type: 'stdio',
  allowed_origins: [`chrome-extension://${extensionId}/`],
}, null, 2));
console.log('Local Qwen helper registered. Reload the extension and connect your viewer.');
