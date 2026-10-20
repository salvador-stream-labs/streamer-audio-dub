import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import xterm from '@xterm/headless';
import {ClaudeLogin, renderedText, terminalCommand} from '../native/claude-login.mjs';
import {claudeAuthorizeURL, claudeAuthorizationCode} from '../src/composer/claude-auth.js';

const token = 'sk-ant-oat01-' + 'test'.repeat(20);
const url = 'https://claude.ai/oauth/authorize?response_type=code&client_id=fixture&redirect_uri=' +
  encodeURIComponent('https://platform.claude.com/oauth/code/callback') +
  '&state=fixture-state&code_challenge_method=S256&code_challenge=' + 'a'.repeat(43);
const signal = () => new AbortController().signal;

test('authorization validation preserves CLI-owned PKCE and refuses redirects or shell/control input', () => {
  assert.equal(claudeAuthorizeURL(url), url);
  for (const value of [url.replace('claude.ai', 'example.com'), url.replace('S256', 'plain'),
    url.replace(encodeURIComponent('https://platform.claude.com/oauth/code/callback'), encodeURIComponent('http://localhost:8000/callback')),
    url.replace('response_type=code', 'response_type=token')]) assert.throws(() => claudeAuthorizeURL(value));
  assert.equal(claudeAuthorizationCode(' code#state '), 'code#state');
  for (const value of ['x', 'code\ninjection', 'code;command', 'code\u001b[1m', 'x'.repeat(513)]) assert.throws(() => claudeAuthorizationCode(value));
  const launch = terminalCommand('/some/cli $(touch bad)/claude', '/tmp/fixture', 'darwin');
  assert.ok(!launch.args.join(' ').includes('touch bad'));
  assert.equal(launch.options.env.STREAMIR_CLAUDE_EXECUTABLE, '/some/cli $(touch bad)/claude');
  assert.equal(launch.options.env.ANTHROPIC_API_KEY, undefined);
});
test('terminal rendering reconstructs wrapped links, cursor edits, colors and OSC hyperlinks', async () => {
  const term = new xterm.Terminal({cols: 80, rows: 60, scrollback: 0, allowProposedApi: true});
  try {
    const rendered = `\x1b[31mwrong\x1b[0m\r\x1b[2K\x1b]8;;${url}\x07${url}\x1b]8;;\x07\r\nYour OAuth token:\r\n${token}\r\n`;
    for (let i = 0; i < rendered.length; i += 13) await new Promise(resolve => term.write(rendered.slice(i, i + 13), resolve));
    const text = renderedText(term);
    assert.ok(text.includes(url)); assert.ok(text.includes(token)); assert.ok(!text.includes('wrong'));
    assert.equal(text.split(url).length, 2, 'OSC target does not duplicate visible URL');
  } finally { term.dispose(); }
});

// Actual system PTY + harmless executable fixture; no Claude login or credentials.
async function fixture(mode, fn) {
  const directory = await mkdtemp(path.join(tmpdir(), "streamir login's fixture-"));
  const executable = path.join(directory, 'claude');
  await writeFile(executable, `#!${process.execPath}
if (!process.stdin.isTTY || !process.stdout.isTTY || process.stdout.columns !== 400) process.exit(3);
if (process.argv[2] !== 'setup-token') process.exit(4);
process.stdin.setRawMode(true);
process.stdout.write(${JSON.stringify(mode)} === 'startup-error' ? 'OAuth error: callback unavailable\\r\\n'
  : '\\x1b[32m'+${JSON.stringify(url)}+'\\x1b[0m\\r\\nPaste code here:\\r\\n');
let code='';
process.stdin.on('data', chunk => {
  for(const char of String(chunk)) {
    if(char === '\\r') {
      if(${JSON.stringify(mode)} === 'wait') return;
      if(code !== 'fixture-code#state' || ${JSON.stringify(mode)} === 'reject') {
        process.stdout.write('OAuth error: invalid code\\r\\n'); return;
      }
      process.stdout.write('Your OAuth token:\\r\\n');
      const token=${JSON.stringify(token)};
      process.stdout.write(token.slice(0,18));
      setTimeout(()=>process.stdout.write(token.slice(18)+'\\r\\n'), 40);
    } else code+=char;
  }
});
`, {mode: 0o700});
  let workdir, child;
  const login = new ClaudeLogin({ttl: mode === 'expire' ? 1000 : 5000, startTimeout: 2000, finishTimeout: 1500, pollInterval: 20,
    launch: (file, args, options) => { workdir = options.cwd; child = spawn(file, args, options); return child; }});
  try { await fn({login, executable, workdir: () => workdir, child: () => child}); }
  finally { await login.cancel(); await rm(directory, {recursive: true, force: true}); }
}
test('local PTY preserves session across requests, exchanges code and removes temporary config', {timeout: 8000}, async () => {
  await fixture('success', async ({login, executable, workdir}) => {
    const start = await login.start(executable, signal());
    assert.equal(start.url, url);
    await assert.rejects(login.start(executable, signal()), error => error.code === 'busy');
    await assert.rejects(login.finish('someone-elses-session', 'fixture-code#state', signal()), error => error.code === 'claude-session');
    assert.deepEqual(await login.finish(start.sessionId, 'fixture-code#state', signal()), {claudeToken: token});
    assert.equal(login.session, null);
    await assert.rejects(access(workdir()), {code: 'ENOENT'});
    await assert.rejects(login.finish(start.sessionId, 'fixture-code#state', signal()), error => error.code === 'claude-session');
  });
});
test('rejected code cleans up without returning any terminal output', {timeout: 8000}, async () => {
  await fixture('reject', async ({login, executable, workdir}) => {
    const start = await login.start(executable, signal());
    await assert.rejects(login.finish(start.sessionId, 'fixture-code#state', signal()), error =>
      error.code === 'claude-code' && !error.message.includes('fixture-code'));
    assert.equal(login.session, null); await assert.rejects(access(workdir()), {code: 'ENOENT'});
  });
});
test('cancellation during exchange terminates PTY and clears sensitive terminal state', {timeout: 8000}, async () => {
  await fixture('wait', async ({login, executable, child, workdir}) => {
    const start = await login.start(executable, signal());
    const controller = new AbortController();
    const pending = login.finish(start.sessionId, 'fixture-code#state', controller.signal);
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(pending, {name: 'AbortError'});
    assert.ok(child().signalCode); assert.equal(login.session, null);
    await assert.rejects(access(workdir()), {code: 'ENOENT'});
  });
});
test('abandoned login expires, and explicit cancellation is idempotent', {timeout: 8000}, async () => {
  await fixture('expire', async ({login, executable, workdir}) => {
    const start = await login.start(executable, signal());
    await delay(1100);
    assert.equal(login.session, null); await assert.rejects(access(workdir()), {code: 'ENOENT'});
    await assert.rejects(login.finish(start.sessionId, 'fixture-code#state', signal()), error => error.code === 'claude-session');
    await login.cancel(start.sessionId);
  });
});
test('CLI startup errors fail promptly and leave no login session or temporary config', {timeout: 8000}, async () => {
  await fixture('startup-error', async ({login, executable, workdir}) => {
    await assert.rejects(login.start(executable, signal()), error => error.code === 'claude-login');
    assert.equal(login.session, null);
    await assert.rejects(access(workdir()), {code: 'ENOENT'});
  });
});
