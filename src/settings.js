import {ERRORS, LANGUAGES, PROVIDERS} from './composer/contract.js';
import {claudeAuthorizeURL, claudeAuthorizationCode} from './composer/claude-auth.js';

const $ = id => document.getElementById(id);
let accountState, cancel, busy = false, loginPort, loginWaiting = false;
function tell(text) { $('status').textContent = text; }
function working(value) {
  busy = value;
  for (const node of document.querySelectorAll('button, select, input')) node.disabled = value || Boolean(loginPort);
  $('cancel').hidden = !value || Boolean(loginPort);
  $('cancel').disabled = false;
  claudeControls();
}
function claudeControls() {
  const found = accountState?.claude?.available === true;
  $('claude-setup').hidden = !found;
  $('claude-option').hidden = !found && $('provider').value !== 'claude-code';
  $('claude-option').disabled = !found;
  $('generate-claude-token').hidden = !accountState?.claude?.canSignIn;
  $('generate-claude-token').disabled = busy || Boolean(loginPort) || !found;
  $('claude-authorization').hidden = !loginWaiting;
  $('claude-code').disabled = !loginWaiting;
  $('finish-claude-login').disabled = !loginWaiting;
  $('cancel-claude-login').hidden = !loginPort;
  $('cancel-claude-login').disabled = false;
  $('remove-claude-token').hidden = !accountState?.claudeTokenSaved;
}
function call(message) {
  working(true);
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({name: 'composer-settings'});
    let done = false;
    const finish = (error, result) => {
      if (done) return; done = true; cancel = null; working(false); port.disconnect();
      if (error) reject(new Error(ERRORS[error] ?? ERRORS.failed)); else resolve(result);
    };
    cancel = () => finish('cancelled');
    port.onMessage.addListener(result => finish(result.error, result.value));
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; finish('setup'); });
    port.postMessage(message);
  });
}
function connection(state) {
  accountState = state;
  const provider = $('provider').value;
  $('connection').textContent = state.connected[provider] ? (provider === 'claude-code' ? 'Token saved' : 'Connected') : 'Not connected';
  $('claude-detection').textContent = state.claude?.available
    ? `Claude Code found: ${state.claude.executable}`
    : state.claude ? 'Claude Code was not found. Token generation is available when it is installed.'
      : 'Update the local helper and check again to detect Claude Code.';
  claudeControls();
  $('accounts').replaceChildren(...state.accounts.map(account => {
    const option = new Option(account.label + (account.connected ? '' : ' (signed out)'), account.id);
    option.selected = account.id === state.activeAccount; return option;
  }));
  $('account-row').hidden = state.accounts.length === 0;
}
function showProvider() {
  const provider = $('provider').value;
  $('api-fields').hidden = !['anthropic', 'openai-api'].includes(provider);
  $('chatgpt-fields').hidden = provider !== 'openai-chatgpt';
  $('model-row').hidden = !['openai-api', 'openai-chatgpt'].includes(provider);
  $('key-label').textContent = provider === 'anthropic' ? 'Anthropic API key' : 'OpenAI API key';
  $('billing').textContent = provider === 'claude-code' ? 'Personal test using Haiku 5.5 through your installed Claude Code and Claude subscription.'
    : provider === 'anthropic' ? 'Haiku 5.5. Usage is billed to your Anthropic API account.'
    : provider === 'openai-api' ? 'Usage is billed to your OpenAI API account.'
      : 'Uses your ChatGPT plan and its app usage limits. Available here through the local helper.';
  $('key').value = '';
  $('models').replaceChildren(new Option('Load models, then choose one', ''));
  if (accountState) connection(accountState);
}
async function savePreferences() {
  if ($('source').value === $('target').value) throw new Error('Choose different input and chat languages.');
  await chrome.storage.local.set({composer: {
    provider: $('provider').value, sourceLanguage: $('source').value, targetLanguage: $('target').value,
    composerEnabled: $('enabled').checked,
    assessmentEnabled: $('assessment-enabled').checked,
  }});
}
async function loadModels() {
  const {models} = await call({type: 'models', provider: $('provider').value});
  $('models').replaceChildren(new Option('Choose a model', ''), ...models.map(m => new Option(m.label, m.id)));
  const key = $('provider').value === 'openai-chatgpt' ? `openai-chatgpt:${accountState?.activeAccount}` : 'openai-api';
  $('models').value = accountState?.models[key] ?? '';
}
function action(id, fn) {
  $(id).addEventListener('click', () => {
    if ((busy || loginPort) && !['cancel', 'cancel-claude-login', 'finish-claude-login'].includes(id)) return;
    Promise.resolve().then(fn).catch(error => tell(error.message));
  });
}
for (const id of ['source', 'target']) for (const [code, name] of Object.entries(LANGUAGES)) $(id).add(new Option(name, code));
$('provider').addEventListener('change', () => {
  showProvider(); savePreferences().then(() => tell('Provider selected.')).catch(e => tell(e.message));
});
for (const id of ['source', 'target', 'enabled', 'assessment-enabled']) $(id).addEventListener('change', () => savePreferences().catch(e => tell(e.message)));
$('accounts').addEventListener('change', () => {
  call({type: 'select-account', accountId: $('accounts').value}).then(state => {
    connection(state); $('models').replaceChildren(new Option('Load models for this account', '')); tell('Account selected.');
  }).catch(e => tell(e.message));
});
$('models').addEventListener('change', () => {
  if (!$('models').value) return;
  call({type: 'select-model', provider: $('provider').value, model: $('models').value})
    .then(state => { connection(state); tell('Model selected.'); }).catch(e => tell(e.message));
});
action('save-key', async () => {
  const key = $('key').value.trim(); $('key').value = '';
  const state = await call({type: 'set-key', provider: $('provider').value, key});
  connection(state); tell('Key saved in the local helper.');
  if ($('provider').value === 'openai-api') await loadModels();
});
action('remove-key', async () => { connection(await call({type: 'remove-key', provider: $('provider').value})); tell('Key removed.'); });
action('sign-in', async () => {
  tell('Complete sign-in in the new browser tab.');
  connection(await call({type: 'sign-in', accountId: $('accounts').value || undefined}));
  tell('ChatGPT connected. Choose a model.'); await loadModels();
});
action('add-account', async () => {
  tell('Complete sign-in in the new browser tab.');
  connection(await call({type: 'sign-in'})); tell('ChatGPT account added.'); await loadModels();
});
action('sign-out', async () => {
  const state = await call({type: 'sign-out', accountId: $('accounts').value});
  connection(state);
  tell(state.revoked ? 'Signed out.' : 'Signed out locally. Remote revocation was not confirmed; disconnect Streamir in ChatGPT Settings.');
});
action('load-models', loadModels);
action('check-claude', async () => { connection(await call({type: 'claude-detect'})); tell('Executable check complete.'); });
action('generate-claude-token', async () => {
  tell('Starting your local Claude Code sign-in…');
  const port = loginPort = chrome.runtime.connect({name: 'composer-claude-login'});
  let done = false;
  const end = message => {
    if (done) return; done = true;
    loginPort = null; loginWaiting = false;
    $('claude-code').value = '';
    $('claude-authorize-link').removeAttribute('href');
    port.disconnect(); working(false);
    if (message) tell(message);
  };
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; end('Claude connection ended. Start again to reconnect.'); });
  port.onMessage.addListener(result => {
    if (result.error) { end(ERRORS[result.error] ?? ERRORS.failed); return; }
    if (result.event === 'authorize') {
      try {
        $('claude-authorize-link').href = claudeAuthorizeURL(result.url);
        loginWaiting = true; working(false);
        tell('Open Claude authorization above. Keep this settings tab open, then paste the code here.');
      } catch { end(ERRORS['claude-login']); }
      return;
    }
    if (result.value?.saved) {
      end();
      call({type: 'claude-detect'}).then(async state => {
        connection(state);
        if (!state.claude?.available) { tell('Token saved, but Claude Code is no longer available. Check its installation.'); return; }
        $('provider').value = 'claude-code'; showProvider(); await savePreferences();
        tell('Token saved automatically. Local Claude selected. Your first draft request will verify authentication.');
      }).catch(error => tell(error.message));
    }
  });
  working(true); port.postMessage({type: 'start'});
});
action('finish-claude-login', () => {
  if (!loginPort || !loginWaiting) return;
  const code = claudeAuthorizationCode($('claude-code').value);
  $('claude-code').value = ''; loginWaiting = false; working(true);
  tell('Claude Code is exchanging the authorization code locally…');
  loginPort.postMessage({type: 'finish', code});
});
action('cancel-claude-login', () => {
  const port = loginPort;
  loginPort = null; loginWaiting = false; $('claude-code').value = '';
  $('claude-authorize-link').removeAttribute('href');
  port?.disconnect(); working(false); tell('Claude connection cancelled.');
});
action('remove-claude-token', async () => {
  await call({type: 'remove-claude-token'});
  connection(await call({type: 'status'})); tell('Claude token removed from this extension.');
});
action('refresh', async () => { connection(await call({type: 'status'})); tell('Connection checked.'); });
action('cancel', () => cancel?.());
const saved = (await chrome.storage.local.get('composer')).composer;
$('provider').value = PROVIDERS.includes(saved?.provider) ? saved.provider : 'anthropic';
$('source').value = saved?.sourceLanguage ?? 'en';
$('target').value = saved?.targetLanguage ?? 'ru';
$('enabled').checked = saved?.composerEnabled !== false;
$('assessment-enabled').checked = saved?.assessmentEnabled === true;
$('install-command').textContent = `node native/install.mjs ${chrome.runtime.id}`;
showProvider();
call({type: 'status'}).then(connection).catch(e => {
  $('claude-detection').textContent = 'Set up the local helper below to check for Claude Code.';
  claudeControls(); tell(e.message);
});
