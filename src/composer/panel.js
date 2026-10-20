import {LANGUAGES, PROVIDERS, ERRORS, variants, assessment, composerRequest} from './contract.js';
import {nativeInput, fillTwitchDraft} from './dom.js';
import {channelFromURL} from '../feed/protocol.js';

const element = (tag, className, text = '') => {
  const node = document.createElement(tag); node.className = className; node.textContent = text;
  if (tag === 'button') node.type = 'button';
  return node;
};
export class ComposerPanel {
  constructor() {
    this.revision = 0; this.items = []; this.page = location.href;
    this.panel = element('section', '');
    this.panel.dataset.ivOwned = 'composer';
    this.panel.setAttribute('aria-label', 'Streamir draft reply helper');
    this.choices = element('div', 'iv-choices');
    this.label = element('label', 'iv-composer-label');
    this.label.htmlFor = 'streamir-draft';
    this.input = element('textarea', ''); this.input.id = 'streamir-draft'; this.input.rows = 2; this.input.maxLength = 500;
    this.input.setAttribute('aria-describedby', 'streamir-draft-disclosure');
    this.generate = element('button', '', 'Propose versions');
    this.cancelButton = element('button', 'iv-quiet', 'Cancel'); this.cancelButton.hidden = true;
    const controls = element('div', 'iv-composer-controls'); controls.append(this.generate, this.cancelButton);
    this.status = element('p', 'iv-composer-status'); this.status.setAttribute('role', 'status');
    this.disclosure = element('p', 'iv-composer-disclosure'); this.disclosure.id = 'streamir-draft-disclosure';
    this.panel.append(this.choices, this.status, this.label, this.input, controls, this.disclosure);
    this.generate.addEventListener('click', () => this.request());
    this.cancelButton.addEventListener('click', () => { this.cancel(); this.status.textContent = ERRORS.cancelled; });
    this.input.addEventListener('input', () => { this.invalidate(); this.status.textContent = ''; });
    this.panel.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.target === this.input && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault(); if (!this.generate.disabled) this.request();
      }
    });
    this.relayout = () => {
      if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.layout(); });
    };
    this.resize = new ResizeObserver(this.relayout);
    window.addEventListener('resize', this.relayout);
    window.addEventListener('scroll', this.relayout, true);
  }
  configure(settings) {
    const next = {
      provider: PROVIDERS.includes(settings?.provider) ? settings.provider : 'anthropic',
      sourceLanguage: Object.hasOwn(LANGUAGES, settings?.sourceLanguage) ? settings.sourceLanguage : 'en',
      targetLanguage: Object.hasOwn(LANGUAGES, settings?.targetLanguage) ? settings.targetLanguage : 'ru',
      assessmentEnabled: settings?.assessmentEnabled === true,
    };
    if (JSON.stringify(next) !== JSON.stringify(this.settings)) this.invalidate();
    this.settings = next; this.enabled = settings?.composerEnabled !== false;
    this.label.textContent = `Reply in ${LANGUAGES[next.targetLanguage]}`;
    this.input.placeholder = `Write your draft in ${LANGUAGES[next.sourceLanguage]}`;
    const provider = {'claude-code': 'Local Claude test · Your Claude subscription',
      anthropic: 'Anthropic Haiku 5.5 · API billing', 'openai-api': 'OpenAI · API billing', 'openai-chatgpt': 'OpenAI · Your ChatGPT plan'}[next.provider];
    this.disclosure.textContent = `${provider}. Recent drafts and refinements${next.provider === 'claude-code' ? ', including wording checks,' : ''} stay in context until two minutes idle. Stream chat is not sent.`;
    this.sync();
  }
  buttons() {
    this.generate.disabled = Boolean(this.busy || this.inserting || !this.input.value.trim());
    this.generate.textContent = this.busy && !this.checkingItem ? 'Preparing versions…' : 'Propose versions';
    this.input.disabled = Boolean(this.inserting);
    this.cancelButton.hidden = !this.busy;
    this.cancelButton.textContent = this.checkingItem ? 'Cancel check' : 'Cancel';
    for (const button of this.choices.querySelectorAll('button')) {
      button.disabled = Boolean(this.inserting || (this.busy && !(this.checkingItem && button.dataset.action === 'use')));
    }
  }
  cancel() {
    const port = this.port; this.port = null;
    this.requestId = (this.requestId ?? 0) + 1;
    if (this.checkingItem) {
      this.checkingItem.assessmentStatus = 'Check cancelled. You can still use this version.';
      this.showAssessment(this.checkingItem); this.checkingItem = null;
    }
    port?.disconnect(); this.busy = false; this.buttons();
  }
  invalidate() {
    this.revision++; this.cancel(); this.fillController?.abort();
    this.items = []; this.choices.replaceChildren(); this.original = '';
  }
  sync() {
    if (this.page !== location.href) {
      this.page = location.href; this.invalidate(); this.input.value = ''; this.status.textContent = '';
    }
    const native = this.enabled && channelFromURL(location.href) ? nativeInput() : null;
    if (!native || this.contextPage !== location.href) {
      const port = this.contextPort; this.contextPort = null; port?.disconnect();
      this.contextPage = location.href;
    }
    if (native && !this.contextPort) {
      try {
        const port = this.contextPort = chrome.runtime.connect({name: 'composer-context'});
        port.onDisconnect.addListener(() => {
          void chrome.runtime.lastError;
          if (this.contextPort === port) this.contextPort = null;
        });
      } catch {}
    }
    if (native !== this.native) {
      this.invalidate(); this.native = native; this.resize.disconnect();
      if (native) this.resize.observe(native.closest('.chat-wysiwyg-input-box') || native);
    }
    if (!native) { this.panel.remove(); return; }
    if (!this.panel.isConnected) document.body.append(this.panel);
    this.relayout(); this.buttons();
  }
  layout() {
    if (!this.native?.isConnected || !this.panel.isConnected) return;
    const box = (this.native.closest('.chat-wysiwyg-input-box') || this.native).getBoundingClientRect();
    const width = Math.min(360, innerWidth - 24), beside = box.left >= width + 24;
    this.panel.style.width = `${width}px`;
    this.panel.style.left = `${beside ? box.left - width - 12 : Math.min(Math.max(12, box.left), innerWidth - width - 12)}px`;
    this.panel.style.bottom = `${Math.max(12, beside ? innerHeight - box.bottom : innerHeight - box.top + 8)}px`;
    this.panel.style.maxHeight = `${Math.max(120, innerHeight - 24)}px`;
  }
  request(index, feedback) {
    if (this.busy || this.inserting || !this.native?.isConnected) return;
    const refining = Number.isInteger(index);
    let request;
    try {
      request = composerRequest({...this.settings, text: refining ? this.original : this.input.value,
        ...(refining ? {refinement: {text: this.items[index].value.text, feedback}} : {})});
    } catch { this.status.textContent = ERRORS.request; return; }
    if (!refining) { this.invalidate(); this.original = request.text; }
    const revision = this.revision, page = location.href, input = this.native, requestId = ++this.requestId;
    this.busy = true; this.buttons(); this.status.textContent = 'Preparing wording and back-translations…';
    let received = false;
    const finish = response => {
      if (requestId !== this.requestId || revision !== this.revision || page !== location.href || input !== this.native) return;
      this.cancel();
      if (response.error) { this.status.textContent = ERRORS[response.error] ?? ERRORS.failed; return; }
      try {
        const result = variants(response.value, refining);
        if (refining) {
          this.items[index].previous = this.items[index].value; this.items[index].value = result[0];
          this.items[index].assessment = null; this.items[index].assessmentStatus = ''; this.items[index].checkVisible = false;
        }
        else this.items = result.map(value => ({value}));
        this.render({revision, page, input});
        this.status.textContent = 'Choose a version. You will send it from Twitch’s chat box.';
      } catch { this.status.textContent = ERRORS.response; }
    };
    try {
      const port = this.port = chrome.runtime.connect({name: 'composer'});
      port.onMessage.addListener(response => { received = true; finish(response); });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (!received && this.port === port) finish({error: 'setup'});
      });
      port.postMessage(request);
    } catch { finish({error: 'setup'}); }
  }
  check(index, context) {
    if (!this.settings.assessmentEnabled || this.busy || this.inserting ||
      context.revision !== this.revision || context.page !== location.href || context.input !== this.native ||
      !this.native?.isConnected) return;
    const item = this.items[index];
    if (item.assessment) {
      item.checkVisible = !item.checkVisible; this.showAssessment(item); return;
    }
    let request;
    try { request = composerRequest({...this.settings, text: this.original, assessment: {text: item.value.text}}); }
    catch { this.status.textContent = ERRORS.request; return; }
    const selected = item.value, requestId = ++this.requestId;
    this.busy = true; this.checkingItem = item; item.checkVisible = true;
    item.assessmentStatus = 'Checking tone, phrasing and references… You can still use this version.';
    this.showAssessment(item); this.buttons();
    let received = false;
    const finish = response => {
      if (requestId !== this.requestId || context.revision !== this.revision || context.page !== location.href ||
        context.input !== this.native || this.items[index] !== item || item.value !== selected) return;
      this.checkingItem = null; this.cancel();
      if (response.error) item.assessmentStatus = response.error === 'response'
        ? 'The check did not return usable advice. Your versions are unchanged.' : ERRORS[response.error] ?? ERRORS.failed;
      else {
        try { item.assessment = assessment(response.value); item.assessmentStatus = ''; }
        catch { item.assessmentStatus = 'The check did not return usable advice. Your versions are unchanged.'; }
      }
      this.showAssessment(item);
    };
    try {
      const port = this.port = chrome.runtime.connect({name: 'composer'});
      port.onMessage.addListener(response => { received = true; finish(response); });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (!received && this.port === port) finish({error: 'setup'});
      });
      port.postMessage(request);
    } catch { finish({error: 'setup'}); }
  }
  showAssessment(item) {
    const view = item.assessmentView;
    if (!view) return;
    view.body.hidden = !item.checkVisible;
    view.toggle.setAttribute('aria-expanded', String(Boolean(item.checkVisible)));
    view.toggle.textContent = item.assessment
      ? (item.checkVisible ? 'Hide wording check' : 'Show wording check') : 'How might this land?';
    view.status.textContent = item.assessmentStatus ?? '';
    view.result.replaceChildren();
    if (item.assessment) {
      view.result.append(element('p', 'iv-assessment-summary', item.assessment.summary));
      const list = element('dl', '');
      for (const [key, label] of [['naturalness', 'Phrasing'], ['tone', 'Tone'], ['references', 'References'], ['suggestion', 'Possible adjustment']]) {
        list.append(element('dt', '', label), element('dd', '', item.assessment[key]));
      }
      view.result.append(list, element('p', 'iv-assessment-note', 'An estimate from the wording only. Shared context and individual reactions can differ.'));
    }
    view.adapt.hidden = !item.assessment;
    this.relayout();
  }
  render(context) {
    this.choices.replaceChildren();
    this.items.forEach((item, index) => {
      const row = element('article', 'iv-choice'), header = element('div', 'iv-choice-heading');
      const actions = element('div', 'iv-choice-actions');
      const use = element('button', 'iv-quiet', 'Use this version'), refine = element('button', 'iv-quiet', 'Refine');
      use.dataset.action = 'use';
      actions.append(use, refine); header.append(element('span', '', item.value.label), actions);
      const text = element('p', 'iv-choice-russian', item.value.text); text.lang = this.settings.targetLanguage;
      const meaning = element('p', 'iv-choice-english', item.value.meaning); meaning.lang = this.settings.sourceLanguage;
      row.append(header, text, meaning);
      use.addEventListener('click', () => this.use(item.value.text, context));
      const editor = element('div', 'iv-refinement'); editor.hidden = true;
      const label = element('label', 'iv-composer-label', 'What would you change?');
      const input = element('textarea', ''); input.id = `streamir-refine-${index}`; input.maxLength = 500; input.rows = 2; label.htmlFor = input.id;
      const update = element('button', '', 'Update wording');
      update.addEventListener('click', () => this.request(index, input.value));
      const shortcuts = element('div', 'iv-refinement-shortcuts');
      for (const tone of ['Shorter', 'Warmer', 'Less playful']) {
        const button = element('button', 'iv-quiet', tone);
        button.addEventListener('click', () => { input.value = `Make it ${tone.toLowerCase()} while preserving the meaning.`; input.focus(); });
        shortcuts.append(button);
      }
      editor.append(label, input, shortcuts, update); row.append(editor);
      refine.setAttribute('aria-expanded', 'false');
      refine.addEventListener('click', () => {
        editor.hidden = !editor.hidden; refine.setAttribute('aria-expanded', String(!editor.hidden));
        if (!editor.hidden) input.focus();
      });
      if (this.settings.assessmentEnabled) {
        const section = element('div', 'iv-assessment');
        const toggle = element('button', 'iv-quiet', 'How might this land?');
        const body = element('div', 'iv-assessment-body'); body.id = `streamir-assessment-${index}`;
        toggle.setAttribute('aria-controls', body.id);
        toggle.addEventListener('click', () => this.check(index, context));
        const status = element('p', 'iv-assessment-note'); status.setAttribute('role', 'status');
        const result = element('div', ''); result.setAttribute('aria-live', 'polite'); result.lang = this.settings.sourceLanguage;
        const adapt = element('button', 'iv-quiet', 'Refine from this advice');
        adapt.addEventListener('click', () => {
          editor.hidden = false; refine.setAttribute('aria-expanded', 'true');
          input.value = item.assessment.suggestion; input.focus();
        });
        body.append(status, result, adapt);
        section.append(toggle, element('p', 'iv-assessment-note', 'A new check uses credits or plan allowance.'), body);
        row.append(section); item.assessmentView = {toggle, body, status, result, adapt}; this.showAssessment(item);
      }
      if (item.previous) {
        const undo = element('button', 'iv-quiet iv-undo', 'Undo refinement');
        undo.addEventListener('click', () => {
          item.value = item.previous; item.previous = null;
          item.assessment = null; item.assessmentStatus = ''; item.checkVisible = false; this.render(context);
        });
        row.append(undo);
      }
      this.choices.append(row);
    });
    this.buttons(); this.relayout();
  }
  async use(text, context) {
    if ((this.busy && !this.checkingItem) || this.inserting || context.revision !== this.revision || context.page !== location.href) return;
    if (this.checkingItem) this.cancel();
    this.inserting = true; this.buttons(); this.fillController = new AbortController();
    try {
      await fillTwitchDraft(text, {...context, signal: this.fillController.signal});
      if (context.revision !== this.revision) return;
      this.invalidate(); this.input.value = ''; this.status.textContent = 'Draft inserted. Review it in Twitch, then press Chat to send.';
    } catch (error) { if (context.revision === this.revision) this.status.textContent = error.message; }
    finally { this.inserting = false; this.buttons(); }
  }
  destroy() {
    this.contextPort?.disconnect(); this.contextPort = null;
    this.invalidate(); this.panel.remove(); this.resize.disconnect(); cancelAnimationFrame(this.frame);
    window.removeEventListener('resize', this.relayout); window.removeEventListener('scroll', this.relayout, true);
  }
}
