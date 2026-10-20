import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {runInNewContext} from 'node:vm';
import {frame, decoder} from '../native/protocol.mjs';
import {build} from 'esbuild';
import {TOKEN_KEY} from '../src/composer/token-store.js';

function event() { const listeners = []; return {addListener: fn => listeners.push(fn), fire: value => listeners.forEach(fn => fn(value)), invoke: (...args) => listeners.map(fn => fn(...args))}; }
function port(name, sender) {
  return {name, sender, onMessage: event(), onDisconnect: event(), messages: [], closed: false,
    postMessage(message) { this.messages.push(message); },
    disconnect() { if (!this.closed) { this.closed = true; this.onDisconnect.fire(); } }};
}
const flush = () => new Promise(resolve => setImmediate(resolve));
async function harness(initial = {}) {
  const built = await build({entryPoints: ['src/background.js'], bundle: true, write: false, format: 'iife', platform: 'browser'});
  const native = port(), runtime = {id: 'test', onConnect: event(), onMessage: event(),
    getURL: name => `chrome-extension://test/${name}`, connectNative: () => native};
  native.postMessage = message => {
    native.messages.push(message);
    if (message.type === 'reset-session') queueMicrotask(() => native.onMessage.fire({id: message.id, value: {reset: true}}));
  };
  const data = structuredClone(initial);
  const local = {
    accessLevel: null,
    async setAccessLevel({accessLevel}) { this.accessLevel = accessLevel; },
    async get(key) { return {[key]: data[key]}; },
    async set(value) { Object.assign(data, value); },
    async remove(key) { delete data[key]; },
  };
  const storage = {local, onChanged: event()};
  runInNewContext(built.outputFiles[0].text, {chrome: {runtime, storage,
    tabs: {create: async () => {}, query: async () => [], sendMessage: async () => {}}},
    URL, crypto, setTimeout, clearTimeout});
  return {runtime, native, storage, data};
}
test('paid assessments require the saved opt-in, regardless of content-supplied flags', async () => {
  for (const enabled of [undefined, false, 'true', true]) {
    const {native, runtime} = await harness({composer: {assessmentEnabled: enabled}});
    const page = port('composer', {id: 'test', frameId: 0, tab: {id: 1}, url: 'https://www.twitch.tv/hexxyi'});
    runtime.onConnect.fire(page);
    page.onMessage.fire({provider: 'anthropic', text: 'Hello', assessment: {text: 'Привет!', history: ['ignored']},
      assessmentEnabled: true});
    await flush();
    if (enabled === true) {
      const sent = native.messages.at(-1);
      assert.equal(sent.type, 'suggest');
      assert.equal(sent.request.assessment.text, 'Привет!');
      assert.equal(sent.request.assessment.history, undefined);
      assert.equal(sent.request.assessmentEnabled, undefined);
      page.disconnect();
      assert.equal(native.messages.at(-1).type, 'cancel');
    } else {
      assert.equal(native.messages.length, 0);
      assert.equal(page.messages[0].error, 'assessment-disabled');
    }
  }
});
test('extension boundary allows settings pages but never exposes credential-management methods to Twitch', async () => {
  const {native, runtime} = await harness();
  const wrong = port('composer-settings', {id: 'test', frameId: 0, tab: {id: 1}, url: 'https://www.twitch.tv/hexxyi'});
  runtime.onConnect.fire(wrong);
  assert.equal(wrong.closed, true);
  assert.equal(native.messages.length, 0);
  const page = port('composer-settings', {id: 'test', url: runtime.getURL('settings.html')});
  runtime.onConnect.fire(page); page.onMessage.fire({type: 'status'});
  assert.equal(native.messages.at(-1).type, 'status');
  native.onMessage.fire({id: native.messages.at(-1).id, value: {connected: {anthropic: false}}});
  await flush();
  assert.equal(page.messages[0].value.connected.anthropic, false);
  const twitch = port('composer', {id: 'test', frameId: 0, tab: {id: 1}, url: 'https://www.twitch.tv/hexxyi'});
  runtime.onConnect.fire(twitch);
  twitch.onMessage.fire({type: 'set-key', provider: 'anthropic', key: 'do-not-forward'});
  await flush();
  assert.equal(twitch.messages[0].error, 'request');
  assert.ok(!JSON.stringify(native.messages).includes('do-not-forward'));
});

test('composer lifetime ports isolate tabs and reset only their trusted session on close', async () => {
  const {native, runtime} = await harness();
  const sender = {id: 'test', frameId: 0, tab: {id: 1}, documentId: 'doc-a', url: 'https://www.twitch.tv/hexxyi'};
  const lifetime = port('composer-context', sender);
  runtime.onConnect.fire(lifetime);
  assert.equal(native.messages.length, 0, 'Opening the composer does not launch a helper or make inference calls');
  const draft = port('composer', sender);
  runtime.onConnect.fire(draft);
  draft.onMessage.fire({provider: 'anthropic', text: 'Hello', contextKey: 'injected'});
  await flush();
  const first = native.messages.at(-1);
  assert.notEqual(first.contextKey, 'injected');
  native.onMessage.fire({id: first.id, value: {variants: []}});
  assert.ok(!native.messages.some(message => message.type === 'cancel'), 'Completing a turn must not interrupt the warm process');
  const otherSender = {...sender, tab: {id: 2}};
  const otherLifetime = port('composer-context', otherSender);
  runtime.onConnect.fire(otherLifetime);
  const otherDraft = port('composer', otherSender);
  runtime.onConnect.fire(otherDraft); otherDraft.onMessage.fire({provider: 'anthropic', text: 'Other tab'});
  await flush();
  const second = native.messages.at(-1);
  assert.notEqual(first.contextKey, second.contextKey);
  native.onMessage.fire({id: second.id, value: {variants: []}});
  lifetime.disconnect(); await flush();
  assert.equal(native.messages.at(-1).type, 'reset-session');
  assert.equal(native.messages.at(-1).contextKey, first.contextKey);
  otherLifetime.disconnect(); await flush();
  assert.equal(native.messages.at(-1).contextKey, second.contextKey);
});

test('Claude tokens stay in trusted storage and only the native inference request receives them', async () => {
  const savedToken = 'sk-ant-oat01-' + 't'.repeat(30);
  const {native, runtime, storage, data} = await harness({
    composer: {provider: 'claude-code', sourceLanguage: 'en', targetLanguage: 'ru', token: 'must-not-expose'},
  });
  const settingsSender = {id: 'test', url: runtime.getURL('settings.html')};
  const twitchSender = {id: 'test', frameId: 0, tab: {id: 1}, url: 'https://www.twitch.tv/hexxyi'};
  const save = port('composer-settings', settingsSender);
  runtime.onConnect.fire(save); save.onMessage.fire({type: 'set-claude-token', token: savedToken});
  await flush();
  assert.equal(storage.local.accessLevel, 'TRUSTED_CONTEXTS');
  assert.equal(data[TOKEN_KEY], savedToken);
  assert.equal(save.messages[0].value.saved, true);
  assert.equal(native.messages.length, 0);

  let preferences;
  runtime.onMessage.invoke({type: 'composer-preferences'}, twitchSender, value => { preferences = value; });
  await flush();
  assert.equal(preferences.preferences.provider, 'claude-code');
  assert.equal(preferences.preferences.token, undefined);
  assert.ok(!JSON.stringify(preferences).includes(savedToken));
  let deniedReply = false;
  runtime.onMessage.invoke({type: 'composer-preferences'}, {...twitchSender, id: 'other'}, () => { deniedReply = true; });
  await flush();
  assert.equal(deniedReply, false);

  const denied = port('composer-settings', twitchSender);
  runtime.onConnect.fire(denied);
  assert.equal(denied.closed, true);
  const draft = port('composer', twitchSender);
  runtime.onConnect.fire(draft);
  draft.onMessage.fire({provider: 'claude-code', text: 'Hello', token: 'injected-token', claudeToken: 'injected-token'});
  await flush();
  const sent = native.messages.at(-1);
  assert.equal(sent.type, 'suggest');
  assert.equal(sent.claudeToken, savedToken);
  assert.equal(sent.request.claudeToken, undefined);
  assert.equal(sent.request.token, undefined);
  native.onMessage.fire({id: sent.id, value: {variants: []}});
  assert.ok(!JSON.stringify(draft.messages).includes(savedToken));

  const remove = port('composer-settings', settingsSender);
  runtime.onConnect.fire(remove); remove.onMessage.fire({type: 'remove-claude-token'});
  await flush();
  assert.equal(data[TOKEN_KEY], undefined);
  const missing = port('composer', twitchSender);
  runtime.onConnect.fire(missing); missing.onMessage.fire({provider: 'claude-code', text: 'Hello'});
  await flush();
  assert.equal(missing.messages[0].error, 'claude-auth');
});

const authorizeURL = 'https://claude.ai/oauth/authorize?response_type=code&client_id=fixture&redirect_uri=' +
  encodeURIComponent('https://platform.claude.com/oauth/code/callback') +
  '&state=fixture-state&code_challenge_method=S256&code_challenge=' + 'a'.repeat(43);
test('local sign-in is owned by its settings port and stores the exchanged token without exposing it', async () => {
  const {native, runtime, data} = await harness();
  const rejected = port('composer-claude-login', {id: 'test', frameId: 0, tab: {id: 1}, url: 'https://www.twitch.tv/hexxyi'});
  runtime.onConnect.fire(rejected); assert.equal(rejected.closed, true);
  const page = port('composer-claude-login', {id: 'test', url: runtime.getURL('settings.html')});
  runtime.onConnect.fire(page); page.onMessage.fire({type: 'start'});
  assert.equal(native.messages.at(-1).type, 'claude-login-start');
  native.onMessage.fire({id: native.messages.at(-1).id, value: {sessionId: 'fixture-session', url: authorizeURL}});
  assert.equal(page.closed, false);
  assert.equal(page.messages[0].url, authorizeURL);
  page.onMessage.fire({type: 'finish', code: 'fixture-code'});
  const finish = native.messages.at(-1);
  assert.equal(finish.sessionId, 'fixture-session'); assert.equal(finish.code, 'fixture-code');
  const token = 'sk-ant-oat01-' + 'z'.repeat(30);
  native.onMessage.fire({id: finish.id, value: {claudeToken: token}});
  await flush();
  assert.equal(data[TOKEN_KEY], token); assert.equal(page.closed, true);
  assert.deepEqual(page.messages.at(-1).value.saved, true);
  assert.ok(!JSON.stringify(page.messages).includes(token));
});
test('closing local sign-in cancels its native session; invalid authorization URLs cannot reach the page', async () => {
  const {native, runtime} = await harness();
  const page = port('composer-claude-login', {id: 'test', url: runtime.getURL('settings.html')});
  runtime.onConnect.fire(page); page.onMessage.fire({type: 'start'});
  native.onMessage.fire({id: native.messages.at(-1).id, value: {sessionId: 'fixture-session', url: authorizeURL}});
  page.disconnect();
  const cancel = native.messages.at(-1);
  assert.equal(cancel.type, 'claude-login-cancel'); assert.equal(cancel.sessionId, 'fixture-session');
  native.onMessage.fire({id: cancel.id, value: {cancelled: true}});
  const unsafe = port('composer-claude-login', {id: 'test', url: runtime.getURL('settings.html')});
  runtime.onConnect.fire(unsafe); unsafe.onMessage.fire({type: 'start'});
  native.onMessage.fire({id: native.messages.at(-1).id, value: {sessionId: 'fixture-session-2', url: 'https://example.com/oauth/authorize'}});
  assert.equal(unsafe.messages[0].error, 'claude-login'); assert.equal(unsafe.closed, true);
  const cleanup = native.messages.at(-1);
  assert.equal(cleanup.type, 'claude-login-cancel');
  native.onMessage.fire({id: cleanup.id, value: {cancelled: true}});
});

test('native installer registers one extension origin and host serves redacted status', {timeout: 15000}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'streamir-install-'));
  const extensionId = 'a'.repeat(32);
  const run = (file, args, options = {}) => new Promise((resolve, reject) => {
    const child = spawn(file, args, options);
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Exit ${code}`)));
  });
  let child;
  try {
    await run(process.execPath, ['native/install.mjs', extensionId], {
      env: {...process.env, STREAMIR_INSTALL_ROOT: directory}, stdio: 'ignore',
    });
    const manifest = JSON.parse(await readFile(path.join(directory, 'NativeMessagingHosts/app.streamir.composer.json'), 'utf8'));
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
    const config = path.join(directory, 'state', extensionId, 'host.json');
    child = spawn(process.execPath, ['native/host.mjs', config, `chrome-extension://${extensionId}/`], {stdio: ['pipe', 'pipe', 'pipe']});
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No native reply')), 5000);
      child.on('error', reject);
      child.stdout.on('data', decoder(value => {
        clearTimeout(timer);
        try {
          assert.equal(value.id, 'status-test');
          assert.equal(value.value.connected.anthropic, false);
          assert.equal(value.value.apiKeys, undefined);
          resolve();
        } catch (error) { reject(error); }
      }));
      child.stdin.write(frame({id: 'status-test', type: 'status'}));
    });
    await new Promise(resolve => { child.once('exit', resolve); child.stdin.end(); });
    child = null;
    const wrongOrigin = spawn(process.execPath, ['native/host.mjs', config, 'chrome-extension://wrong/'], {stdio: 'ignore'});
    const code = await new Promise(resolve => wrongOrigin.once('exit', resolve));
    assert.equal(code, 1);
  } finally {
    if (child) await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
    await rm(directory, {recursive: true, force: true});
  }
});
