document.getElementById('extension-id').textContent = chrome.runtime.id;
document.getElementById('install-command').textContent = `node native/install.mjs ${chrome.runtime.id} /absolute/path/to/voice-config.json`;
