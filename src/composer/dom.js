// Fill Twitch's editor through its editing handlers. Twitch owns submission.
// No private React properties, cookies or network endpoints are used.
export const INPUT = '[data-a-target="chat-input"]';
export function nativeDraft(input) {
  if ('value' in input) return input.value.trim();
  const copy = input.cloneNode(true);
  copy.querySelectorAll('[data-slate-placeholder], [data-slate-zero-width]').forEach(node => node.remove());
  // An emote-only draft still belongs to the user, even if textContent is empty.
  copy.querySelectorAll('img').forEach(node => node.replaceWith(document.createTextNode(node.alt || '\ufffc')));
  return copy.textContent.replace(/[\u200b\ufeff]/gu, '').trim();
}
export function nativeInput() {
  return [...document.querySelectorAll(INPUT)].find(input => input.checkVisibility() && !input.closest('[hidden], [aria-hidden="true"]'));
}
function writable(input) {
  return input?.isConnected && input.checkVisibility() && !input.disabled && !input.readOnly && input.getAttribute('aria-disabled') !== 'true' &&
    (input.isContentEditable || input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement);
}

export async function fillTwitchDraft(text, {input, page, signal}) {
  const current = () => !signal.aborted && location.href === page && nativeInput() === input && writable(input);
  if (!current()) throw new Error('Chat changed or is unavailable. Request fresh suggestions.');
  if (nativeDraft(input)) throw new Error('Twitch already has a draft. Send or clear it before choosing a translation.');
  input.focus();
  if (input.isContentEditable) {
    // Select a real Slate leaf, not the editor root. Replacing the root's DOM
    // via execCommand breaks Slate's model and leaves its placeholder visible.
    const leaf = input.querySelector('[data-slate-string], [data-slate-zero-width]');
    if (!leaf) throw new Error('Twitch’s editor is not ready. Reload this Twitch tab, then choose a version again.');
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(leaf); range.collapse(false);
    selection.removeAllRanges(); selection.addRange(range);
    // Slate synchronizes DOM selection asynchronously. Wait only during this
    // explicit action, then recheck the draft before dispatching a plain paste.
    await new Promise(resolve => setTimeout(resolve, 60));
    if (!current() || document.activeElement !== input || !selection.isCollapsed ||
        !input.contains(selection.anchorNode) || nativeDraft(input)) {
      throw new Error('Chat changed. Your existing draft has been preserved.');
    }
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    input.dispatchEvent(new ClipboardEvent('paste', {clipboardData, bubbles: true, cancelable: true}));
  } else {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, text);
    input.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: text}));
  }
  // A handled paste updates Slate's state and renders data-slate-string nodes.
  // A raw DOM mutation alone is not evidence of successful insertion.
  for (let i = 0; i < 15; i++) {
    await new Promise(resolve => setTimeout(resolve, 40));
    if (!current()) throw new Error('Chat changed. Check Twitch’s input before continuing.');
    const value = nativeDraft(input);
    if (value && value !== text) throw new Error('Twitch’s draft changed. Check it before continuing.');
    const rendered = !input.isContentEditable || Boolean(input.querySelector('[data-slate-string]'));
    if (value === text && rendered) return;
  }
  throw new Error('Twitch did not accept the draft. Copy a Russian option and paste it into Twitch manually.');
}
