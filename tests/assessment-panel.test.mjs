import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {build} from 'esbuild';

const versions = {variants: [
  {label: 'Natural', text: 'Привет!', meaning: 'Hello!'},
  {label: 'Casual', text: 'Всем привет!', meaning: 'Hello everyone!'},
  {label: 'Warm', text: 'Рад вас видеть!', meaning: 'Good to see you!'},
]};
const advice = {assessment: {summary: 'Friendly.', naturalness: 'Natural in chat.', tone: 'Casual.',
  references: 'No reference stands out.', suggestion: 'Keep the greeting but make it shorter.'}};
const preferences = {provider: 'anthropic', sourceLanguage: 'en', targetLanguage: 'ru', assessmentEnabled: true};
const event = () => {
  const listeners = [];
  return {addListener: fn => listeners.push(fn), fire: value => listeners.forEach(fn => fn(value))};
};
// A DOM/event fixture for state transitions. Browser layout and Twitch's Slate
// paste handling are exercised by composer-browser.mjs instead.
async function harness(enabled = true) {
  class Node {
    constructor(tag) {
      this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.attributes = {};
      this.listeners = {}; this.value = ''; this.textContent = ''; this.isConnected = false;
    }
    append(...nodes) { this.children.push(...nodes); for (const node of nodes) node.isConnected = true; }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
    fire(name) { for (const fn of this.listeners[name] ?? []) fn({target: this}); }
    click() { if (!this.disabled) this.fire('click'); }
    querySelectorAll(tag) { return this.children.flatMap(node => [...(node.tag === tag ? [node] : []), ...node.querySelectorAll(tag)]); }
    checkVisibility() { return true; }
    closest() { return null; }
    focus() {}
    remove() { this.isConnected = false; }
  }
  const native = new Node('textarea'); native.isConnected = true;
  const ports = [];
  const chrome = {runtime: {connect({name}) {
    const port = {name, onMessage: event(), onDisconnect: event(), closed: false, messages: [],
      postMessage(value) { this.messages.push(value); },
      disconnect() { if (!this.closed) { this.closed = true; this.onDisconnect.fire(); } }};
    ports.push(port); return port;
  }}};
  const location = {href: 'https://www.twitch.tv/hexxyi'};
  const built = await build({stdin: {
    contents: "import {ComposerPanel} from './src/composer/panel.js'; globalThis.Panel = ComposerPanel;",
    resolveDir: process.cwd(),
  }, bundle: true, write: false, format: 'iife'});
  const globals = {chrome, location, URL, AbortController, setTimeout, clearTimeout,
    document: {createElement: tag => new Node(tag), querySelectorAll: () => [native], body: new Node('body')},
    window: {addEventListener() {}, removeEventListener() {}},
    ResizeObserver: class {observe() {} disconnect() {}},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  };
  runInNewContext(built.outputFiles[0].text, globals);
  const panel = new globals.Panel();
  panel.configure({...preferences, assessmentEnabled: enabled});
  const latest = () => ports.filter(port => port.name === 'composer').at(-1);
  const count = () => ports.reduce((sum, port) => sum + port.messages.length, 0);
  const buttons = name => panel.choices.querySelectorAll('button').filter(button => button.textContent === name);
  const generate = () => {
    panel.input.value = 'Hello!'; panel.input.fire('input'); panel.generate.click();
    latest().onMessage.fire({value: versions});
  };
  return {panel, ports, latest, count, buttons, generate, location};
}

test('checks stay off by default; translations complete without triggering an assessment', async () => {
  const h = await harness(false);
  try {
    h.generate();
    assert.equal(h.panel.items.length, 3);
    assert.equal(h.count(), 1);
    assert.equal(h.buttons('How might this land?').length, 0);
    h.panel.configure(preferences);
    assert.equal(h.count(), 1, 'Enabling checks makes no inference request');
    h.generate();
    assert.equal(h.count(), 2);
    assert.equal(h.buttons('How might this land?').length, 3);
  } finally { h.panel.destroy(); }
});

test('one chosen version is checked; cached advice and opening refinement do not spend again', async () => {
  const h = await harness();
  try {
    h.generate(); h.buttons('How might this land?')[1].click();
    assert.equal(h.count(), 2);
    assert.equal(h.latest().messages[0].assessment.text, versions.variants[1].text);
    assert.equal(h.buttons('Use this version')[1].disabled, false);
    assert.equal(h.panel.cancelButton.textContent, 'Cancel check');
    h.latest().onMessage.fire({value: advice});
    assert.equal(h.panel.items[0].assessment, undefined);
    assert.equal(h.panel.items[1].assessment.summary, advice.assessment.summary);
    h.buttons('Hide wording check')[0].click();
    h.buttons('Show wording check')[0].click();
    assert.equal(h.count(), 2);
    h.buttons('Refine from this advice')[1].click();
    assert.equal(h.count(), 2, 'The viewer must explicitly submit a refinement');
    const feedback = h.panel.choices.querySelectorAll('textarea')[1];
    assert.equal(feedback.value, advice.assessment.suggestion);
    h.buttons('Update wording')[1].click();
    assert.equal(h.count(), 3);
    assert.equal(h.latest().messages[0].refinement.feedback, advice.assessment.suggestion);
    h.latest().onMessage.fire({value: {variants: [{label: 'Shorter', text: 'Привет всем!', meaning: 'Hi all!'}]}});
    assert.equal(h.panel.items[1].assessment, null);
    assert.equal(h.panel.items[1].checkVisible, false, 'Advice for old wording must be discarded');
    h.buttons('Undo refinement')[0].click();
    assert.equal(h.panel.items[1].value.text, versions.variants[1].text);
    assert.equal(h.count(), 3);
  } finally { h.panel.destroy(); }
});

test('failed or cancelled checks preserve choices and reject late results', async () => {
  const h = await harness();
  try {
    h.generate(); h.buttons('How might this land?')[0].click();
    h.latest().onMessage.fire({error: 'limit'});
    assert.equal(h.panel.items.length, 3); assert.equal(h.panel.busy, false);
    assert.match(h.panel.items[0].assessmentStatus, /usage limit/);
    h.buttons('How might this land?')[0].click();
    const stale = h.latest();
    h.panel.cancelButton.click();
    assert.equal(stale.closed, true); assert.equal(h.panel.items.length, 3);
    stale.onMessage.fire({value: advice});
    assert.equal(h.panel.items[0].assessment, undefined);
    assert.match(h.panel.items[0].assessmentStatus, /cancelled/);
  } finally { h.panel.destroy(); }
});

test('editing, disabling checks and changing channels cancel work and discard stale advice', async () => {
  for (const change of [
    h => { h.panel.input.value = 'New draft'; h.panel.input.fire('input'); },
    h => h.panel.configure({...preferences, assessmentEnabled: false}),
    h => { h.location.href = 'https://www.twitch.tv/anotherchannel'; h.panel.sync(); },
  ]) {
    const h = await harness();
    try {
      h.generate(); h.buttons('How might this land?')[0].click();
      const stale = h.latest();
      change(h);
      assert.equal(stale.closed, true);
      stale.onMessage.fire({value: advice});
      assert.equal(h.panel.items.length, 0); assert.equal(h.panel.busy, false);
    } finally { h.panel.destroy(); }
  }
});
