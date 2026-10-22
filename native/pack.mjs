import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {config} from './config.mjs';
const argv = process.argv.slice(2);
const at = argv.indexOf('--config');
if (!['build', 'inspect'].includes(argv[0]) || at < 0 || !argv[at + 1]) throw new Error('Usage: node native/pack.mjs build|inspect ... --config voice-config.json');
const cfg = config(JSON.parse(await readFile(argv[at + 1], 'utf8')));
const rest = argv.filter((_, i) => i !== at && i !== at + 1);
const child = spawn(cfg.python, ['-I', fileURLToPath(new URL('./pack.py', import.meta.url)), rest[0], ...(rest[0] === 'build' ? ['--config-json', '-'] : []), ...rest.slice(1)],
  {stdio: ['pipe', 'inherit', 'inherit']});
child.stdin.end(JSON.stringify(cfg));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
