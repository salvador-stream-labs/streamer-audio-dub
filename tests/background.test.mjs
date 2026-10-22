import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
const root = new URL('../', import.meta.url);
function event() { const listeners = []; return {addListener(f) { listeners.push(f); }, emit(...args) { return listeners.map(f => f(...args)); }}; }
function port(sender, name = 'local-voice') {
  return {sender, name, onMessage: event(), onDisconnect: event(), messages: [], disconnected: false,
    postMessage(m) { this.messages.push(m); }, disconnect() { if (!this.disconnected) { this.disconnected = true; this.onDisconnect.emit(); } }};
}
async function fixture() {
  const base = 'chrome-extension://' + 'a'.repeat(32) + '/';
  const native = [], removed = [], injected = [];
  const chrome = {runtime: {id: 'a'.repeat(32), getURL: p => base + p, onMessage: event(), onConnect: event(),
    connectNative() { const p = port(); native.push(p); return p; }},
    storage: {local: {setAccessLevel: async () => {}, remove: async v => removed.push(...v)}},
    tabs: {get: async id => ({id, url: 'https://viewer.example/watch'})},
    scripting: {executeScript: async p => injected.push(p)},
  };
  const bundled = await build({entryPoints: [new URL('src/background.js', root).pathname], bundle: true, write: false, format: 'iife', platform: 'browser'});
  vm.runInNewContext(bundled.outputFiles[0].text, {chrome, URL, Date, structuredClone});
  await Promise.resolve();
  const activate = () => new Promise(resolve => chrome.runtime.onMessage.emit({type: 'activate', tabId: 7}, {id: chrome.runtime.id, url: base + 'popup.html'}, resolve));
  return {chrome, native, removed, injected, base, activate};
}
test('only a popup-granted exact tab can access the native voice host', async () => {
  const x = await fixture(); const sender = {id: x.chrome.runtime.id, frameId: 0, tab: {id: 7}, url: 'https://viewer.example/watch'};
  const denied = port(sender); x.chrome.runtime.onConnect.emit(denied);
  assert.equal(denied.disconnected, true); assert.equal(x.native.length, 0);
  assert.equal((await x.activate()).ok, true);
  const wrongFrame = port({...sender, frameId: 2}); x.chrome.runtime.onConnect.emit(wrongFrame); assert.equal(wrongFrame.disconnected, true);
  const allowed = port(sender); x.chrome.runtime.onConnect.emit(allowed); assert.equal(x.native.length, 1);
  const another = port(sender); x.chrome.runtime.onConnect.emit(another); assert.equal(another.disconnected, true);
  allowed.onMessage.emit({type: 'execute', path: '/bin/sh'}); assert.equal(x.native[0].messages.length, 0);
  allowed.onMessage.emit({type: 'status', v: 'local_voice_v1', id: 'status'}); assert.equal(x.native[0].messages.length, 1);
  allowed.disconnect(); assert.equal(x.native[0].disconnected, true);
  assert(x.removed.includes('streamirClaudeToken'));
});
test('repeated activation of an already-connected tab preserves its live bridge', async () => {
  const x = await fixture(); await x.activate();
  const p = port({id: x.chrome.runtime.id, frameId: 0, tab: {id: 7}, url: 'https://viewer.example/watch'});
  x.chrome.runtime.onConnect.emit(p); await x.activate();
  assert.equal(p.disconnected, false); assert.equal(x.injected.length, 1);
  p.disconnect();
});
test('manifest no longer injects Twitch chat code or requests persistent host access', async () => {
  const m = JSON.parse(await readFile(new URL('extension/manifest.json', root)));
  assert.equal(m.content_scripts, undefined); assert.equal(m.host_permissions, undefined);
  assert(m.permissions.includes('activeTab')); assert.equal(m.name, 'Streamir: Local Qwen Voice');
});
