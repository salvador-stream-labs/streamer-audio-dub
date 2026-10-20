import {mkdir, writeFile, chmod} from 'node:fs/promises';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {HOST} from '../src/composer/contract.js';
import {searchDirectories} from './claude.mjs';

const extensionId = process.argv[2];
if (!/^[a-p]{32}$/.test(extensionId ?? '')) throw new Error('Usage: node native/install.mjs YOUR_CHROME_EXTENSION_ID');
if (!['darwin', 'linux'].includes(process.platform)) throw new Error('This development installer supports macOS and Linux.');
const root = fileURLToPath(new URL('../', import.meta.url));
const dataDirectory = process.env.STREAMIR_INSTALL_ROOT
  ? path.resolve(process.env.STREAMIR_INSTALL_ROOT, 'state', extensionId)
  : path.join(homedir(), '.config', 'streamir-composer', extensionId);
const manifestDirectory = process.env.STREAMIR_INSTALL_ROOT
  ? path.resolve(process.env.STREAMIR_INSTALL_ROOT, 'NativeMessagingHosts')
  : process.platform === 'darwin'
    ? path.join(homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts')
    : path.join(homedir(), '.config/google-chrome/NativeMessagingHosts');
await mkdir(dataDirectory, {recursive: true, mode: 0o700});
await chmod(dataDirectory, 0o700);
await mkdir(manifestDirectory, {recursive: true});
const config = path.join(dataDirectory, 'host.json');
await writeFile(config, JSON.stringify({extensionId, dataDirectory, claudeSearchPaths: searchDirectories()}), {mode: 0o600});
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const launcher = path.join(dataDirectory, 'launch.sh');
await writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, 'native/host.mjs'))} ${quote(config)} "$@"\n`, {mode: 0o700});
await chmod(launcher, 0o700);
await writeFile(path.join(manifestDirectory, `${HOST}.json`), JSON.stringify({
  name: HOST, description: 'Streamir chat composer credentials and provider requests',
  path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`],
}, null, 2));
console.log('Streamir composer helper registered. Reload the extension, then open its connection settings.');
