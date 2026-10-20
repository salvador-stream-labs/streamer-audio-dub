import {readFile} from 'node:fs/promises';
import {CredentialStore} from './store.mjs';
import {ComposerService} from './service.mjs';
import {LocalClaude, searchDirectories} from './claude.mjs';
import {frame, decoder} from './protocol.mjs';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (!/^[a-p]{32}$/.test(config.extensionId) || process.argv[3] !== `chrome-extension://${config.extensionId}/`) process.exit(1);
const store = new CredentialStore(config.dataDirectory);
let release, active, loginStart, closing = false;
const send = value => { if (!closing) process.stdout.write(frame(value)); };
async function stop() {
  if (closing) return;
  closing = true;
  active?.controller.abort();
  if (active) await active.done.catch(() => {});
  await service?.close();
  await service?.claude?.login.cancel();
  await release?.();
  process.exit(0);
}
for (const event of ['end', 'error']) process.stdin.on(event, () => void stop());
process.stdout.on('error', () => void stop());
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
let service, startupError;
try {
  release = await store.lock();
  service = new ComposerService(store, {claude: new LocalClaude({directories: searchDirectories(config.claudeSearchPaths)})});
  await service.initialize();
}
catch (error) { startupError = error.code === 'busy' ? 'busy' : 'setup'; }

function receive(message) {
  if (closing || !message || typeof message.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(message.id)) return;
  if (message.type === 'cancel') {
    if (active?.id === message.requestId) active.controller.abort();
    // A page can disappear just after start returned its URL. The request ID
    // still identifies that session even if the page never received its ID.
    if (loginStart?.requestId === message.requestId) void service.claude.login.cancel(loginStart.sessionId);
    return;
  }
  if (startupError) { send({id: message.id, error: startupError}); return; }
  if (message.type === 'reset-session') {
    if (message.contextKey === undefined || message.contextKey === service.contextKey) active?.controller.abort();
    void service.resetSession(message.contextKey).then(value => send({id: message.id, value}))
      .catch(() => send({id: message.id, error: 'failed'}));
    return;
  }
  // Session cleanup must work even if an unrelated inference request is active.
  if (message.type === 'claude-login-cancel') {
    void service.claude.login.cancel(message.sessionId).then(value => send({id: message.id, value}))
      .catch(() => send({id: message.id, error: 'failed'}));
    return;
  }
  if (active) { send({id: message.id, error: 'busy'}); return; }
  const controller = new AbortController();
  const request = {id: message.id, controller};
  active = request;
  const timer = setTimeout(() => controller.abort(), message.type === 'sign-in' ? 190000 : 65000);
  request.done = service.handle(message, {signal: controller.signal, onURL: async url => send({id: message.id, event: 'authorize', url})})
    .then(async value => {
      if (message.type === 'claude-login-start') loginStart = {requestId: message.id, sessionId: value.sessionId};
      if (!controller.signal.aborted) send({id: message.id, value});
      else {
        if (message.type === 'claude-login-start') await service.claude.login.cancel(value.sessionId);
        send({id: message.id, error: 'cancelled'});
      }
    })
    .catch(error => send({id: message.id, error: controller.signal.aborted ? 'cancelled' : error.code ?? 'failed'}))
    .finally(() => { clearTimeout(timer); if (active === request) active = null; });
}
const accept = decoder(receive);
process.stdin.on('data', chunk => { try { accept(chunk); } catch { void stop(); } });
