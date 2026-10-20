import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';

const browser = await chromium.launch({headless: true});
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 850}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://www.twitch.tv/**', route => route.fulfill({contentType: 'text/html; charset=utf-8', body: `<!doctype html>
    <html><meta charset="utf-8"><style>
    body{margin:0;background:#161a19;color:#e8efeb;font:15px system-ui}
    main{position:fixed;inset:20px 390px 220px 20px;background:#252c29;display:grid;place-items:center}
    aside{position:fixed;right:0;bottom:20px;width:350px;padding:15px}
    .chat-wysiwyg-input-box{padding:12px;border:1px solid #88968d}
    [contenteditable]{min-height:50px} button{padding:8px 16px;margin-top:12px}
    </style><main>hexxyi · Stream video</main><aside>
    <div class="chat-wysiwyg-input-box"><div role="textbox" aria-label="Twitch draft" contenteditable="true" data-a-target="chat-input"><span data-slate-zero-width="z">&#xfeff;</span></div></div>
    <button id="chat-send">Chat</button></aside></html>`}));
  await page.goto('https://www.twitch.tv/hexxyi');
  await page.addStyleTag({content: await readFile(new URL('../dist/composer.css', import.meta.url), 'utf8')});
  await page.evaluate(() => {
    const event = () => { const listeners = []; return {addListener: fn => listeners.push(fn), fire: value => listeners.forEach(fn => fn(value))}; };
    window.requests = []; window.posts = []; window.preferenceListeners = [];
    window.response = {value: {variants: [
      {label: 'Natural', text: 'Спасибо за стрим!', meaning: 'Thanks for the stream!'},
      {label: 'Casual', text: 'Классный стрим, спасибо!', meaning: 'Great stream, thanks!'},
      {label: 'Warm', text: 'Очень рад быть на стриме!', meaning: 'Very happy to be at the stream!'},
    ]}};
    window.chrome = {
      runtime: {id: 'test', onMessage: {addListener: fn => preferenceListeners.push(fn)},
      sendMessage: async () => ({preferences: {provider: 'anthropic', sourceLanguage: 'en', targetLanguage: 'ru'}}),
      connect() {
        const port = {onMessage: event(), onDisconnect: event(), closed: false,
          postMessage(value) { requests.push(value); if (!window.hold) setTimeout(() => { if (!port.closed) port.onMessage.fire(window.response); }, 20); },
          disconnect() { if (!port.closed) { port.closed = true; port.onDisconnect.fire(); } },
        };
        return port;
      }},
    };
    const input = document.querySelector('[data-a-target="chat-input"]');
    input.addEventListener('paste', event => {
      event.preventDefault();
      const leaf = document.createElement('span'); leaf.dataset.slateString = 'true'; leaf.textContent = event.clipboardData.getData('text/plain');
      input.replaceChildren(leaf);
    });
    document.getElementById('chat-send').addEventListener('click', () => posts.push(input.textContent));
  });
  await page.addScriptTag({path: new URL('../dist/content.js', import.meta.url).pathname});
  const draft = page.getByLabel('Reply in Russian', {exact: true});
  await draft.waitFor();
  assert.equal(await page.evaluate(() => requests.length), 0);
  await draft.fill('Thanks for the stream!');
  await page.getByRole('button', {name: 'Propose versions', exact: true}).click();
  await page.locator('.iv-choice').first().waitFor();
  assert.equal(await page.locator('.iv-choice').count(), 3);
  assert.equal(await page.evaluate(() => posts.length), 0);

  await page.locator('.iv-choice').first().getByRole('button', {name: 'Refine', exact: true}).click();
  await page.getByLabel('What would you change?', {exact: true}).first().fill('Make it shorter');
  await page.evaluate(() => { response = {value: {variants: [{label: 'Shorter', text: 'Спасибо!', meaning: 'Thanks!'}]}}; });
  await page.getByRole('button', {name: 'Update wording', exact: true}).click();
  await page.getByRole('button', {name: 'Undo refinement', exact: true}).waitFor();
  assert.equal(await page.locator('.iv-choice-russian').first().textContent(), 'Спасибо!');
  await page.getByRole('button', {name: 'Undo refinement', exact: true}).click();
  assert.equal(await page.locator('.iv-choice-russian').first().textContent(), 'Спасибо за стрим!');

  await page.getByRole('button', {name: 'Use this version', exact: true}).first().click();
  await page.waitForFunction(() => document.querySelector('.iv-composer-status').textContent.includes('Draft inserted'));
  assert.equal(await page.locator('[data-a-target="chat-input"]').textContent(), 'Спасибо за стрим!');
  assert.equal(await page.evaluate(() => posts.length), 0, 'Insertion must never click Chat');

  await page.evaluate(() => {
    for (const fn of preferenceListeners) fn({type: 'composer-preferences', preferences: {provider: 'openai-chatgpt', sourceLanguage: 'en', targetLanguage: 'ru'}}, {id: 'test'});
    response = {value: {variants: [
      {label: 'One', text: 'Привет!', meaning: 'Hello!'}, {label: 'Two', text: 'Всем привет!', meaning: 'Hello everyone!'},
      {label: 'Three', text: 'Рад вас видеть!', meaning: 'Good to see you!'},
    ]}};
  });
  await draft.fill('Hello everyone!');
  await page.getByRole('button', {name: 'Propose versions', exact: true}).click();
  await page.locator('.iv-choice').first().waitFor();
  assert.equal(await page.evaluate(() => requests.at(-1).provider), 'openai-chatgpt');
  await page.getByRole('button', {name: 'Use this version', exact: true}).first().click();
  await page.waitForFunction(() => document.querySelector('.iv-composer-status').textContent.includes('already has a draft'));
  assert.equal(await page.locator('[data-a-target="chat-input"]').textContent(), 'Спасибо за стрим!');
  const beforeChecks = await page.evaluate(() => requests.length);
  await page.evaluate(() => {
    for (const fn of preferenceListeners) fn({type: 'composer-preferences', preferences: {
      provider: 'openai-chatgpt', sourceLanguage: 'en', targetLanguage: 'ru', assessmentEnabled: true,
    }}, {id: 'test'});
  });
  assert.equal(await page.evaluate(() => requests.length), beforeChecks);
  await page.getByRole('button', {name: 'Propose versions', exact: true}).click();
  await page.locator('.iv-choice').first().waitFor();
  assert.equal(await page.evaluate(() => requests.length), beforeChecks + 1);
  await page.evaluate(() => {
    response = {value: {assessment: {
      summary: 'A friendly greeting.',
      naturalness: 'Natural and brief for a live chat.',
      tone: 'Casual without assuming familiarity.',
      references: 'No cultural reference stands out.',
      suggestion: 'No change is needed.',
    }}};
  });
  await page.getByRole('button', {name: 'How might this land?', exact: true}).first().click();
  await page.getByRole('button', {name: 'Hide wording check', exact: true}).waitFor();
  assert.equal(await page.evaluate(() => requests.at(-1).assessment.text), 'Привет!');
  await page.getByRole('button', {name: 'Hide wording check', exact: true}).click();
  await page.getByRole('button', {name: 'Show wording check', exact: true}).click();
  assert.equal(await page.evaluate(() => requests.length), beforeChecks + 2, 'Cached checks do not spend again');
  assert.equal(await page.evaluate(() => posts.length), 0);
  await mkdir(new URL('../test-results/', import.meta.url), {recursive: true});
  await page.screenshot({path: new URL('../test-results/composer-desktop.png', import.meta.url).pathname});
  await page.setViewportSize({width: 430, height: 850});
  await page.screenshot({path: new URL('../test-results/composer-narrow.png', import.meta.url).pathname});
  const bounds = await page.locator('[data-iv-owned="composer"]').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 430);
  assert.deepEqual(errors, []);
  console.log('Composer browser checks passed: choices, refinement, undo, provider switching, optional assessments, cached advice, draft preservation, and no automatic sending.');
} finally { await browser.close(); }
