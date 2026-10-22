import {chromium} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const files = new Map([
  ['/content.js', ['dist/content.js', 'text/javascript']],
  ['/viewer-local-voice.js', ['dist/viewer-local-voice.js', 'text/javascript']],
  ['/settings.html', ['dist/settings.html', 'text/html']],
  ['/settings.js', ['dist/settings.js', 'text/javascript']],
  ['/settings.css', ['dist/settings.css', 'text/css']],
]);
const server = createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><title>Viewer fixture</title><body><h1>Streamir viewer fixture</h1></body></html>'); return; }
  const entry = files.get(req.url);
  if (!entry) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', entry[1]); res.end(await readFile(entry[0]));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const callbacks = [], disconnect = [];
    window.forwarded = []; window.helperKey = 'A'.repeat(43);
    window.reply = value => callbacks.forEach(f => f(value));
    window.chrome = {runtime: {id: 'a'.repeat(32), connect: () => ({
      onMessage: {addListener: f => callbacks.push(f)}, onDisconnect: {addListener: f => disconnect.push(f)},
      disconnect: () => disconnect.forEach(f => f()), postMessage: m => {
        window.forwarded.push(m);
        if (m.type === 'voice_identity') {
          setTimeout(() => window.reply({id: m.id, value: {voice: window.identityVoice ?? 'pack', model: {}, model_id: 'qwen3_tts-base-test-12hz', public_key: window.helperKey}}), 0);
        } else if (m.type === 'voice_load') { window.load = m;
        } else if (m.type === 'voice_part') {
          setTimeout(() => {
            window.reply({id: m.id, value: {index: m.index}});
            if (m.index !== window.load.parts - 1) return;
            setTimeout(() => {
              if (window.failLoadOnce) { window.failLoadOnce = false; window.helperKey = 'B'.repeat(43); window.reply({id: window.load.id, error: 'voice'}); }
              else window.reply({id: window.load.id, value: {loaded: true, pack_id: 'p', mode: 'icl'}});
            }, 30);
          }, 0);
        } else if (m.type === 'speak') {
          if (window.loseVoice) { const n = +window.loseVoice; window.loseVoice = n > 1 ? n - 1 : false; setTimeout(() => window.reply({id: m.id, error: 'no_voice'}), 0); return; }
          if (m.job.utterance_id === 'held') { window.held = m; return; }
          setTimeout(() => {
            window.reply({id: m.id, event: 'pcm', index: 0, sampleRate: 24000, data: btoa('\0'.repeat(4800))});
            window.reply({id: m.id, value: {sampleRate: 24000, samples: 2400, chunks: 1, duration: .1}});
          }, 10);
        } else setTimeout(() => window.reply({id: m.id, value: {loaded: true, device: 'fixture'}}), 0);
      },
    })}};
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  await page.addScriptTag({url: origin + '/content.js'});
  const states = await page.evaluate(async () => {
    const {LocalVoice} = await import('/viewer-local-voice.js');
    window.states = [];
    window.voice = new LocalVoice({timing: 'as-ready', onState: s => window.states.push(s)});
    await voice.start();
    const job = {session: 'browser', utterance_id: '1', text: 'Thank you.', language: 'en', t_start: 10, t_end: 12, prosody: null};
    await voice.speak(job);
    window.cancelled = voice.speak({...job, utterance_id: 'held'}).catch(e => e.message);
    await new Promise(resolve => setTimeout(resolve, 20));
    await voice.reset();
    const held = window.held;
    window.reply({id: held.id, event: 'pcm', index: 0, sampleRate: 24000, data: btoa('\0\0')});
    window.reply({id: held.id, value: {sampleRate: 24000, samples: 1, chunks: 1}});
    const result = {states, cancellation: await window.cancelled, queued: voice.playback.queue.length,
      translatedText: window.forwarded.find(m => m.type === 'speak').job.text};
    await voice.close();
    const obtained = [];
    const quiet = new LocalVoice({playback: false, onState: s => window.states.push(s), obtainVoice: async identity => { await window.gate; obtained.push(identity.public_key); return {grant: {v: 'voice_grant_v1'}, signature: 'A'.repeat(86), pack: new Uint8Array(20000).fill(3)}; }});
    window.failLoadOnce = true;
    await quiet.start();
    window.loseVoice = true;
    const generated = await quiet.speak({session: 'browser', utterance_id: '9', text: 'Again.', language: 'en', t_start: 1, t_end: 2, prosody: null});
    result.reloaded = [...obtained];
    result.partCount = window.forwarded.filter(m => m.type === 'voice_part').length;
    result.generatedSamples = generated.samples.length;
    result.loadSize = window.load.size;
    const quietJob = {session: 'browser', utterance_id: 'x', text: 'Again.', language: 'en', t_start: 1, t_end: 2, prosody: null};
    const loads = () => window.forwarded.filter(m => m.type === 'voice_load').length;
    // Two speaks lose the voice together: they share one load.
    window.loseVoice = 2; const before = loads();
    const both = await Promise.allSettled([quiet.speak({...quietJob, utterance_id: '10'}), quiet.speak({...job, utterance_id: '11'})]);
    result.concurrent = both.map(r => r.status); result.concurrentLoads = loads() - before;
    // A second no_voice after one reload rejects.
    window.loseVoice = 2; const again = await quiet.speak({...quietJob, utterance_id: '12'}).catch(e => ({message: e.message, code: e.code}));
    window.loseVoice = false;
    result.secondLoss = again;
    // A reset while obtainVoice is pending abandons the reload and rejects the speak as cancelled.
    let release; window.gate = new Promise(resolve => { release = resolve; });
    window.loseVoice = true; const loadsBefore = loads(); const mark = window.states.length;
    const abandoned = quiet.speak({...quietJob, utterance_id: '13'}).then(() => 'resolved', e => ({message: e.message, code: e.code}));
    await new Promise(resolve => setTimeout(resolve, 50));
    await quiet.reset(); release(); window.gate = null;
    result.abandoned = await abandoned; result.abandonedLoads = loads() - loadsBefore;
    result.loadedAfterReset = window.states.slice(mark).some(s => s.state === 'voice' && s.loaded);
    await quiet.close();
    const pack = gate => async () => { await gate; return {grant: {v: 'voice_grant_v1'}, signature: 'A'.repeat(86), pack: new Uint8Array(20000).fill(3)}; };
    // A reset while start() waits on obtainVoice rejects start() as cancelled instead of leaving it loading.
    let open; const startGate = new Promise(resolve => { open = resolve; });
    const pending = new LocalVoice({playback: false, onState: s => window.states.push(s), obtainVoice: pack(startGate)});
    const startMark = window.states.length;
    const starting = pending.start().then(() => 'resolved', e => ({message: e.message, code: e.code}));
    await new Promise(resolve => setTimeout(resolve, 50));
    const loadsBeforeStartReset = loads();
    await pending.reset(); open();
    result.startReset = await starting; result.startResetLoads = loads() - loadsBeforeStartReset;
    result.startResetReady = window.states.slice(startMark).some(s => s.state === 'ready'); result.startResetStarted = pending.started;
    await pending.close();
    // A helper outside pack mode never becomes ready, so its preset voice cannot be played as the streamer's.
    window.identityVoice = 'preset'; let asked = 0;
    const preset = new LocalVoice({playback: false, onState: s => window.states.push(s), obtainVoice: async () => { asked++; }});
    const presetMark = window.states.length;
    result.presetStatus = await preset.start();
    result.presetStates = window.states.slice(presetMark);
    result.presetSpeak = await preset.speak({...quietJob, utterance_id: '20'}).then(() => 'resolved', e => e.message);
    result.presetAsked = asked; result.presetStarted = preset.started;
    window.identityVoice = undefined; await preset.close();
    return result;
  });
  assert(states.states.some(s => s.state === 'playing' && s.synchronized === false));
  assert.match(states.cancellation, /cancelled/); assert.equal(states.queued, 0); assert.equal(states.translatedText, 'Thank you.');
  assert.deepEqual(states.reloaded, ['A'.repeat(43), 'B'.repeat(43), 'B'.repeat(43)]);
  assert.equal(states.partCount, 6); assert.equal(states.generatedSamples, 2400); assert.equal(states.loadSize, 20000);
  assert.deepEqual(states.concurrent, ['fulfilled', 'fulfilled']); assert.equal(states.concurrentLoads, 1);
  assert.match(states.secondLoss.message, /Load the streamer voice first/); assert.equal(states.secondLoss.code, 'no_voice');
  assert.deepEqual(states.abandoned, {message: 'Voice generation was cancelled.', code: 'cancelled'}); assert.equal(states.abandonedLoads, 0); assert.equal(states.loadedAfterReset, false);
  assert(states.states.some(s => s.state === 'voice' && s.loaded === true && s.pack_id === 'p' && s.mode === 'icl'));
  assert.deepEqual(states.startReset, {message: 'Voice generation was cancelled.', code: 'cancelled'});
  assert.equal(states.startResetLoads, 0); assert.equal(states.startResetReady, false); assert.equal(states.startResetStarted, false);
  assert.deepEqual(states.presetStatus, {loaded: true, device: 'fixture'});
  assert(states.presetStates.some(s => s.state === 'voice' && s.loaded === false && s.reason === 'not_pack' && s.voice === 'preset'));
  assert.equal(states.presetStates.some(s => s.state === 'ready'), false);
  assert.match(states.presetSpeak, /Enable local voice first/); assert.equal(states.presetAsked, 0); assert.equal(states.presetStarted, false);
  await page.goto(origin + '/settings.html');
  await page.setViewportSize({width: 360, height: 780});
  assert.equal(await page.locator('#extension-id').textContent(), 'a'.repeat(32));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('input[type=password]').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: text/PCM bridge, explicit delayed playback, reset suppression, setup page at 360px.');
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
