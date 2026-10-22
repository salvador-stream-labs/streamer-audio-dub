const status = document.getElementById('status');
document.getElementById('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('connect').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    const result = await chrome.runtime.sendMessage({type: 'activate', tabId: tab.id});
    status.textContent = result.error || 'Connected. Enable local voice in the viewer.';
  } catch { status.textContent = 'Could not connect. Open the viewer and try again.'; }
});
document.getElementById('disconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({type: 'disconnect'});
  status.textContent = 'Local voice disconnected.';
});
