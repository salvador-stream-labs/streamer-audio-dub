import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, chmod, mkdir, access, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {LocalClaude, findExecutable, commandOptions, parseResult, runClaude} from '../native/claude.mjs';
import {ClaudeTokenStore} from '../src/composer/token-store.js';
import {ComposerService} from '../native/service.mjs';

const token = 'sk-ant-oat01-' + 't'.repeat(30);
const request = {provider: 'claude-code', text: 'Hello everyone', sourceLanguage: 'en', targetLanguage: 'ru'};
const output = {variants: [
  {label: 'Natural', text: 'Привет всем!', meaning: 'Hello everyone!'},
  {label: 'Casual', text: 'Всем привет!', meaning: 'Hi all!'},
  {label: 'Warm', text: 'Всем большой привет!', meaning: 'A big hello to everyone!'},
]};
const successful = JSON.stringify({subtype: 'success', is_error: false, structured_output: output});

test('detection requires an executable file and token setup rechecks after removal', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "streamir cli's test-"));
  const executable = path.join(directory, 'claude');
  let launched = 0;
  const local = new LocalClaude({directories: [directory], platform: 'darwin', login: {start: async file => {
    launched++;
    assert.equal(file, executable);
    return {sessionId: 'fixture-session'};
  }}});
  try {
    assert.equal((await local.detect()).available, false);
    await mkdir(executable);
    assert.equal(await findExecutable([directory]), null, 'Directories cannot be launched');
    await rm(executable, {recursive: true});
    await writeFile(executable, '#!/bin/sh\nexit 0\n', {mode: 0o600});
    assert.equal(await findExecutable([directory]), null, 'Non-executable files are ignored');
    await chmod(executable, 0o700);
    const found = await local.detect();
    assert.equal(found.available, true); assert.equal(found.executable, executable);
    assert.equal(found.canSignIn, true);
    await local.generateToken(new AbortController().signal);
    await rm(executable);
    await assert.rejects(local.generateToken(new AbortController().signal), error => error.code === 'claude-missing');
    assert.equal(launched, 1);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('token storage fails closed if Chrome cannot restrict content-script access', async () => {
  let written = false;
  const store = new ClaudeTokenStore({
    setAccessLevel: async () => { throw new Error('restriction failed'); },
    set: async () => { written = true; }, get: async () => { throw new Error('must not read'); },
  });
  await assert.rejects(store.set(token), /restriction failed/);
  await assert.rejects(store.get(), /restriction failed/);
  assert.equal(written, false);
});

test('CLI uses only the supplied subscription token, isolated settings, and stdin for the draft', () => {
  const options = commandOptions({...request, history: ['private']}, {token, workdir: '/tmp/test'});
  assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, token);
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) assert.equal(options.env[key], undefined);
  assert.equal(options.env.CLAUDE_CONFIG_DIR, '/tmp/test');
  assert.ok(!options.args.includes('--bare'));
  assert.equal(options.args[options.args.indexOf('--model') + 1], 'claude-haiku-5-5');
  assert.equal(options.args[options.args.indexOf('--tools') + 1], '');
  assert.ok(options.args.includes('--restricted')); assert.ok(options.args.includes('--no-session-persistence'));
  assert.ok(!JSON.stringify(options.args).includes(token));
  assert.ok(!JSON.stringify(options.args).includes(request.text));
  assert.deepEqual(JSON.parse(options.input), {draft: request.text});
});

test('CLI accepts only complete structured choices and redacts failure details', () => {
  assert.deepEqual(parseResult(successful, '', 0, false), output);
  assert.throws(() => parseResult(successful, '', 1, false), error => error.code === 'response');
  assert.throws(() => parseResult(successful, '', 0, true), error => error.code === 'response');
  for (const [message, code] of [['401 invalid token', 'claude-auth'], ['429 usage limit', 'limit'],
    ['model not available', 'claude-model'], ['unknown option', 'claude-missing']]) {
    assert.throws(() => parseResult('{}', `${message} ${token}`, 1, false), error => error.code === code && !error.message.includes(token));
  }
  const unsafe = structuredClone(output); unsafe.variants[0].text = '/ban someone';
  assert.throws(() => parseResult(JSON.stringify({subtype: 'success', structured_output: unsafe}), '', 0, false));
});

test('native Claude requests reuse a fixture process and remove its temporary directory on close', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'streamir-cli-process-'));
  let workdir, local, launches = 0;
  try {
    await symlink(process.execPath, path.join(directory, 'claude'));
    const fixture = path.join(directory, 'fixture.mjs');
    await writeFile(fixture, `
      import {createInterface} from 'node:readline';
      if (process.env.CLAUDE_CODE_OAUTH_TOKEN !== ${JSON.stringify(token)}) process.exit(3);
      if (process.argv.includes(${JSON.stringify(token)})) process.exit(4);
      for await (const line of createInterface({input: process.stdin})) {
        const input = JSON.parse(line);
        if (input.type === 'control_request') {
          process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:input.request_id,response:{commands:[]}}})+'\\n');
        } else {
          if (JSON.parse(input.message.content).draft !== 'Hello everyone') process.exit(2);
          process.stdout.write(JSON.stringify({type:'result',...${successful}})+'\\n');
        }
      }
    `);
    local = new LocalClaude({directories: [directory], launch: (file, args, options) => {
      launches++;
      workdir = options.cwd;
      return spawn(file, [fixture, ...args], options);
    }});
    for (let i = 0; i < 2; i++) {
      assert.deepEqual((await local.suggest(request, {token, signal: new AbortController().signal})).variants, output.variants);
    }
    assert.equal(launches, 1);
    await access(workdir);
    await local.close();
    await assert.rejects(access(workdir), {code: 'ENOENT'});
  } finally { await local?.close(); await rm(directory, {recursive: true, force: true}); }
});

test('cancellation terminates the local process', {timeout: 5000}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'streamir-cli-cancel-'));
  const controller = new AbortController();
  let child;
  try {
    const fixture = path.join(directory, 'waiting.mjs');
    await writeFile(fixture, "process.stderr.write('ready'); setInterval(() => {}, 1000);");
    const pending = runClaude(request, {token, executable: process.execPath, workdir: directory, signal: controller.signal},
      (file, args, options) => {
        child = spawn(file, [fixture, ...args], options);
        child.stderr.once('data', () => controller.abort());
        return child;
      });
    await assert.rejects(pending, {name: 'AbortError'});
    assert.ok(['SIGTERM', 'SIGKILL'].includes(child.signalCode));
  } finally { child?.kill('SIGKILL'); await rm(directory, {recursive: true, force: true}); }
});

test('native service never persists the browser-held token or falls back to API billing', async () => {
  const state = {hostId: 'test', accounts: [], apiKeys: {anthropic: 'must-not-use'}, models: {}};
  let captured;
  const service = new ComposerService({read: async () => state, write: async value => {
    assert.ok(!JSON.stringify(value).includes(token));
  }}, {fetchImpl: async () => { throw new Error('Unexpected direct API request'); },
    claude: {
      detect: async () => ({available: true, executable: '/fixture/claude'}),
      suggest: async (payload, options) => { captured = {payload, options}; return output; },
    }});
  await service.initialize();
  assert.equal((await service.handle({type: 'claude-detect'}, {})).claude.available, true);
  assert.deepEqual((await service.handle({type: 'suggest', request, claudeToken: token}, {})).variants, output.variants);
  assert.deepEqual(captured.payload, request); assert.equal(captured.options.token, token);
  assert.ok(!JSON.stringify(service.status()).includes(token));
  await assert.rejects(service.handle({type: 'set-key', provider: 'claude-code', key: token}, {}), error => error.code === 'request');
});
