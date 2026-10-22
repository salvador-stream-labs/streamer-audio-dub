import {HOST, allowedPage, request} from './voice/contract.js';
// Remove credentials belonging to the retired composer; never expose them to pages.
void chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}).then(() =>
  chrome.storage.local.remove(['streamirClaudeToken', 'composer']));
let owner = null, native = null, grant = null;
const popupURL = chrome.runtime.getURL('popup.html');
function stop() {
  const client = owner, helper = native;
  owner = native = null;
  helper?.disconnect(); client?.disconnect();
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.url !== popupURL) return false;
  if (message?.type === 'disconnect') { grant = null; stop(); reply({ok: true}); return false; }
  if (message?.type !== 'activate' || !Number.isInteger(message.tabId)) return false;
  void (async () => {
    const tab = await chrome.tabs.get(message.tabId);
    if (!allowedPage(tab.url)) throw new Error('Open the Streamir viewer over HTTPS, or localhost for development.');
    if (owner?.sender?.tab?.id === tab.id && owner.sender.url === tab.url) { reply({ok: true}); return; }
    stop();
    grant = {tabId: tab.id, url: tab.url, expires: Date.now() + 5000};
    await chrome.scripting.executeScript({target: {tabId: tab.id, frameIds: [0]}, files: ['content.js']});
    reply({ok: true});
  })().catch(error => { grant = null; reply({error: error.message}); });
  return true;
});
chrome.runtime.onConnect.addListener(client => {
  const s = client.sender;
  if (client.name !== 'local-voice' || s?.id !== chrome.runtime.id || s.frameId !== 0 ||
      !grant || grant.tabId !== s.tab?.id || grant.url !== s.url || grant.expires < Date.now()) {
    client.disconnect(); return;
  }
  grant = null; owner = client;
  let closed = false;
  const send = message => { if (!closed) client.postMessage(message); };
  const helper = native = chrome.runtime.connectNative(HOST);
  helper.onMessage.addListener(send);
  helper.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (native === helper) native = null;
    send({error: 'setup'}); client.disconnect();
  });
  client.onMessage.addListener(value => {
    try { helper.postMessage(request(value)); }
    catch { send({id: value?.id, error: 'invalid'}); }
  });
  client.onDisconnect.addListener(() => {
    closed = true;
    if (owner === client) owner = null;
    if (native === helper) native = null;
    helper.disconnect();
  });
});
