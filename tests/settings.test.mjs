import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {build} from 'esbuild';

test('settings gate local sign-in on detection and complete URL/code exchange without a token field', async () => {
  const html = await readFile(new URL('../extension/settings.html', import.meta.url), 'utf8');
  const nodes = new Map();
  for (const match of html.matchAll(/<([\w-]+)([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const [, tag, attributes, id] = match;
    nodes.set(id, {
      tag, hidden: /\bhidden\b/.test(attributes), disabled: /\bdisabled\b/.test(attributes),
      value: '', checked: false, textContent: '', listeners: {}, children: [],
      addEventListener(type, fn) { this.listeners[type] = fn; },
      add(option) { this.children.push(option); },
      replaceChildren(...children) { this.children = children; },
      removeAttribute(name) { delete this[name]; },
      click() { if (!this.disabled && !this.hidden) this.listeners.click?.(); },
    });
  }
  class Option {
    constructor(text, value) { this.text = text; this.value = value; }
  }
  const requests = [], preferences = [];
  let found = false, tokenSaved = false;
  const status = () => ({
    connected: {'claude-code': found && tokenSaved}, accounts: [], models: {}, activeAccount: null,
    claudeTokenSaved: tokenSaved,
    claude: {available: found, executable: found ? '/fixture/claude' : null, canSignIn: found},
  });
  const chrome = {
    storage: {local: {get: async () => ({}), set: async value => { preferences.push(value); }}},
    runtime: {id: 'a'.repeat(32), connect({name}) {
      let listener, closed = false;
      return {
        onMessage: {addListener: fn => { listener = fn; }}, onDisconnect: {addListener() {}},
        disconnect() { closed = true; },
        postMessage(message) {
          requests.push(message);
          let result;
          if (name === 'composer-claude-login' && message.type === 'start') {
            result = {event: 'authorize', url: 'https://claude.ai/oauth/authorize?response_type=code&client_id=fixture&redirect_uri=' +
              encodeURIComponent('https://platform.claude.com/oauth/code/callback') +
              '&state=fixture-state&code_challenge_method=S256&code_challenge=' + 'a'.repeat(43)};
          } else if (message.type === 'finish') { tokenSaved = true; result = {value: {saved: true}}; }
          else result = {value: status()};
          queueMicrotask(() => { if (!closed) listener(result); });
        },
      };
    }},
  };
  const built = await build({entryPoints: ['src/settings.js'], bundle: true, write: false, format: 'esm', platform: 'browser'});
  await runInNewContext(`(async () => { ${built.outputFiles[0].text} })()`, {
    document: {getElementById: id => nodes.get(id),
      querySelectorAll: () => [...nodes.values()].filter(node => ['button', 'input', 'select'].includes(node.tag))},
    chrome, Option, console, URL,
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  assert.equal(nodes.get('assessment-enabled').checked, false);
  nodes.get('assessment-enabled').checked = true;
  nodes.get('assessment-enabled').listeners.change(); await flush();
  assert.equal(preferences.at(-1).composer.assessmentEnabled, true);
  assert.ok(!requests.some(request => request.type === 'suggest'), 'Enabling checks must not spend credits');
  nodes.get('assessment-enabled').checked = false;
  nodes.get('assessment-enabled').listeners.change(); await flush();
  assert.equal(preferences.at(-1).composer.assessmentEnabled, false);
  assert.equal(nodes.get('claude-setup').hidden, true);
  assert.equal(nodes.get('claude-option').hidden, true);
  assert.equal(nodes.get('generate-claude-token').disabled, true);
  nodes.get('generate-claude-token').click();
  await flush();
  assert.equal(requests.filter(r => r.type === 'start').length, 0);

  found = true; nodes.get('check-claude').click(); await flush();
  assert.equal(nodes.get('claude-setup').hidden, false);
  assert.equal(nodes.get('claude-option').hidden, false);
  assert.equal(nodes.get('generate-claude-token').disabled, false);
  nodes.get('generate-claude-token').click(); await flush();
  assert.equal(requests.filter(r => r.type === 'start').length, 1);
  assert.equal(nodes.get('claude-authorization').hidden, false);
  assert.match(nodes.get('claude-authorize-link').href, /^https:\/\/claude.ai/);
  assert.equal(nodes.get('claude-token'), undefined);

  nodes.get('claude-code').value = 'fixture-code';
  nodes.get('finish-claude-login').click(); await flush();
  assert.equal(nodes.get('claude-code').value, '');
  assert.equal(nodes.get('claude-authorization').hidden, true);
  assert.equal(nodes.get('claude-authorize-link').href, undefined);
  assert.equal(nodes.get('provider').value, 'claude-code');
  assert.equal(preferences.at(-1).composer.provider, 'claude-code');
  assert.ok(!JSON.stringify(preferences).includes('sk-ant-oat01-'));
  assert.equal(nodes.get('remove-claude-token').hidden, false);
  found = false; nodes.get('check-claude').click(); await flush();
  assert.equal(nodes.get('claude-setup').hidden, true);
  assert.equal(nodes.get('claude-option').disabled, true);
  assert.equal(nodes.get('generate-claude-token').disabled, true);
});
