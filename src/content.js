import {VERSION, request} from './voice/contract.js';
// Injected only by an explicit click on the extension action.
if (!globalThis.__streamirLocalVoice) {
  globalThis.__streamirLocalVoice = true;
  const port = chrome.runtime.connect({name: 'local-voice'});
  let closed = false;
  const send = payload => window.postMessage({source: 'streamir-local-voice', v: VERSION, ...payload}, location.origin);
  function receive(event) {
    if (closed || event.source !== window || event.origin !== location.origin || event.data?.source !== 'streamir-viewer') return;
    try {
      const {source, ...payload} = event.data;
      port.postMessage(request(payload));
    } catch { send({id: event.data?.id, error: 'invalid'}); }
  }
  window.addEventListener('message', receive);
  port.onMessage.addListener(send);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    closed = true;
    window.removeEventListener('message', receive);
    delete globalThis.__streamirLocalVoice;
    send({event: 'disconnected'});
  });
  window.addEventListener('pagehide', () => port.disconnect(), {once: true});
  send({event: 'connected'});
}
