import {HOST, ERRORS, ComposerError, composerRequest, composerPreferences} from './composer/contract.js';
import {ClaudeTokenStore} from './composer/token-store.js';
import {claudeAuthorizeURL, claudeAuthorizationCode} from './composer/claude-auth.js';
import {channelFromURL} from './feed/protocol.js';

let native;
const tokens = new ClaudeTokenStore(chrome.storage.local);
void tokens.secure().catch(() => {}); // Each credential access also awaits this restriction.
const pending = new Map();
const contexts = new Map();
const contextBase = sender => `${sender.tab.id}:${sender.documentId ?? 'legacy'}:${channelFromURL(sender.url)}`;
function resetNativeSession(contextKey) {
  if (!native) return Promise.resolve();
  return new Promise(resolve => call({type: 'reset-session', ...(contextKey ? {contextKey} : {})}, resolve));
}
function connect() {
  if (native) return native;
  const port = native = chrome.runtime.connectNative(HOST);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (native === port) native = null;
    for (const request of pending.values()) request.finish({error: 'setup'});
    pending.clear();
  });
  port.onMessage.addListener(message => {
    const request = pending.get(message?.id);
    if (!request) return;
    if (message.event === 'authorize') {
      if (!request.allowAuth) return;
      try {
        const url = new URL(message.url);
        if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize') throw new Error();
        chrome.tabs.create({url: url.href}).catch(() => request.finish({error: 'failed'}));
      } catch { request.finish({error: 'failed'}); }
      return;
    }
    request.finish(message.error ? {error: message.error in ERRORS ? message.error : 'failed'} : {value: message.value});
  });
  return port;
}
function call(message, callback, allowAuth = false) {
  const id = crypto.randomUUID();
  let finished = false;
  const request = {allowAuth, finish: value => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    pending.delete(id);
    callback(value);
  }};
  const timer = setTimeout(() => {
    native?.postMessage({id: crypto.randomUUID(), type: 'cancel', requestId: id});
    request.finish({error: 'timeout'});
  }, allowAuth ? 195000 : 70000);
  pending.set(id, request);
  try { connect().postMessage({...message, id}); } catch { request.finish({error: 'setup'}); }
  return () => {
    if (finished) return;
    try { native?.postMessage({id: crypto.randomUUID(), type: 'cancel', requestId: id}); } catch {}
    request.finish({error: 'cancelled'});
  };
}
const management = new Set(['status', 'set-key', 'remove-key', 'sign-in', 'sign-out', 'select-account', 'models', 'select-model',
  'claude-detect', 'set-claude-token', 'remove-claude-token']);

// A single port owns the full login. Closing the page cancels its local PTY.
function claudeLogin(client) {
  let phase = 'idle', sessionId, cancelRequest, closed = false;
  const send = message => { if (!closed) client.postMessage(message); };
  const cleanup = () => {
    cancelRequest?.(); cancelRequest = null;
    if (sessionId) {
      call({type: 'claude-login-cancel', sessionId}, () => {});
      sessionId = null;
    }
  };
  const finish = result => { send(result); client.disconnect(); };
  const expiry = setTimeout(() => finish({error: 'claude-session'}), 600000);
  client.onDisconnect.addListener(() => { closed = true; clearTimeout(expiry); cleanup(); });
  client.onMessage.addListener(message => {
    try {
      if (message?.type === 'start' && phase === 'idle') {
        phase = 'starting';
        cancelRequest = call({type: 'claude-login-start'}, result => {
          if (result.error) { finish(result); return; }
          sessionId = result.value?.sessionId;
          try {
            const url = claudeAuthorizeURL(result.value?.url);
            if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(sessionId)) throw new Error();
            phase = 'waiting';
            send({event: 'authorize', url});
          } catch { finish({error: 'claude-login'}); }
        });
      } else if (message?.type === 'finish' && phase === 'waiting') {
        const code = claudeAuthorizationCode(message.code);
        phase = 'finishing';
        cancelRequest = call({type: 'claude-login-finish', sessionId, code}, result => {
          if (result.error) { finish(result); return; }
          sessionId = null; // The native host has already disposed the session.
          if (closed) return;
          tokens.set(result.value?.claudeToken).then(() => resetNativeSession()).then(() => finish({value: {saved: true}}))
            .catch(() => finish({error: 'claude-auth'}));
        });
      } else finish({error: 'request'});
    } catch (error) { finish({error: error.code ?? 'request'}); }
  });
}
function twitchSender(sender) {
  return sender?.id === chrome.runtime.id && sender.frameId === 0 &&
    Number.isInteger(sender.tab?.id) && Boolean(channelFromURL(sender.url));
}
// Content scripts receive only whitelisted preferences, never local storage.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== 'composer-preferences' || !twitchSender(sender)) return false;
  tokens.secure().then(() => chrome.storage.local.get('composer'))
    .then(saved => reply({preferences: composerPreferences(saved.composer)}))
    .catch(() => reply({error: 'setup'}));
  return true;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.composer) return;
  void resetNativeSession();
  const message = {type: 'composer-preferences', preferences: composerPreferences(changes.composer.newValue)};
  chrome.tabs.query({url: 'https://www.twitch.tv/*'}).then(tabs =>
    Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, message, {frameId: 0})))).catch(() => {});
});
chrome.runtime.onConnect.addListener(client => {
  const sender = client.sender;
  if (sender?.id !== chrome.runtime.id || (sender.frameId !== undefined && sender.frameId !== 0)) { client.disconnect(); return; }
  const trustedPage = !sender.tab && [chrome.runtime.getURL('popup.html'), chrome.runtime.getURL('settings.html')].includes(sender.url);
  // Extension tabs also carry sender.tab; validate their exact URL.
  const settingsPage = sender.url === chrome.runtime.getURL('settings.html');
  const twitch = twitchSender(sender);
  if (client.name === 'composer-context') {
    if (!twitch) { client.disconnect(); return; }
    const base = contextBase(sender);
    const entry = {key: crypto.randomUUID()};
    const previous = contexts.get(base);
    contexts.set(base, entry);
    if (previous) void resetNativeSession(previous.key);
    client.onDisconnect.addListener(() => {
      if (contexts.get(base) === entry) contexts.delete(base);
      void resetNativeSession(entry.key);
    });
    return;
  }
  if (client.name === 'composer-claude-login') {
    if (!settingsPage) { client.disconnect(); return; }
    claudeLogin(client); return;
  }
  if ((client.name === 'composer' && !twitch) ||
    (client.name === 'composer-settings' && !trustedPage && !settingsPage) ||
    !['composer', 'composer-settings'].includes(client.name)) { client.disconnect(); return; }
  let cancel, consumed = false, closed = false;
  const finish = result => {
    if (closed) return;
    try { client.postMessage(result); } catch {}
    client.disconnect();
  };
  client.onMessage.addListener(message => {
    if (consumed) return;
    consumed = true;
    void (async () => {
      let request;
      if (client.name === 'composer') {
        request = {type: 'suggest', request: composerRequest(message),
          contextKey: contexts.get(contextBase(sender))?.key ?? contextBase(sender)};
        if (request.request.assessment) {
          await tokens.secure();
          const saved = await chrome.storage.local.get('composer');
          if (!composerPreferences(saved.composer).assessmentEnabled) throw new ComposerError('assessment-disabled');
        }
        if (request.request.provider === 'claude-code') {
          request.claudeToken = await tokens.get();
          if (!request.claudeToken) throw new ComposerError('claude-auth');
        }
      }
      else {
        if (!management.has(message?.type)) throw new ComposerError('request');
        if (message.type === 'set-claude-token' || message.type === 'remove-claude-token') {
          if (message.type === 'set-claude-token') await tokens.set(message.token);
          else await tokens.remove();
          await resetNativeSession();
          finish({value: {saved: message.type === 'set-claude-token'}});
          return;
        }
        request = message;
      }
      if (closed) return;
      cancel = call(request, result => {
        if (client.name === 'composer-settings' && result.value?.connected) {
          tokens.has().then(saved => finish({value: {...result.value,
            claudeTokenSaved: saved,
            connected: {...result.value.connected, 'claude-code': saved && Boolean(result.value.claude?.available)},
          }})).catch(() => finish({error: 'setup'}));
        } else finish(result);
      }, request.type === 'sign-in');
    })().catch(error => finish({error: error.code in ERRORS ? error.code : 'request'}));
  });
  client.onDisconnect.addListener(() => { closed = true; cancel?.(); });
});
