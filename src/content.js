import {ComposerPanel} from './composer/panel.js';
const composer = new ComposerPanel();
let queued = false;
const observer = new MutationObserver(mutations => {
  if (queued || mutations.every(m => m.target instanceof Element && m.target.closest('[data-iv-owned="composer"]'))) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; composer.sync(); });
});
observer.observe(document.body, {childList: true, subtree: true});
chrome.runtime.sendMessage({type: 'composer-preferences'}).then(value => {
  if (value?.preferences) composer.configure(value.preferences);
}).catch(() => {});
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === chrome.runtime.id && message?.type === 'composer-preferences') composer.configure(message.preferences);
});
window.addEventListener('pagehide', () => { observer.disconnect(); composer.destroy(); }, {once: true});
