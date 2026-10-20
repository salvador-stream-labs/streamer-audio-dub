import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, symlink, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ComposerSession} from '../native/session.mjs';
import {LocalClaude, commandOptions} from '../native/claude.mjs';
import {ComposerService} from '../native/service.mjs';
import {composerRequest, promptFor, claudePromptFor} from '../src/composer/contract.js';

const request = {provider: 'claude-code', text: 'Hello everyone', sourceLanguage: 'en', targetLanguage: 'ru'};
const token = 'sk-ant-oat01-' + 't'.repeat(30);
const variants = [
  {label: 'Natural', text: 'Всем привет!', meaning: 'Hello everyone!'},
  {label: 'Casual', text: 'Привет всем!', meaning: 'Hi everyone!'},
  {label: 'Warm', text: 'Рад вас видеть!', meaning: 'Good to see you!'},
];
const output = {variants};
const assessment = {summary: 'Friendly.', naturalness: 'Natural for chat.', tone: 'Casual.',
  references: 'No reference stands out.', suggestion: 'No change needed.'};
const tick = () => new Promise(resolve => setImmediate(resolve));

test('suggestions and refinement share a stable system prompt and schema, with no history accepted from content', () => {
  const refine = {...request, refinement: {text: variants[0].text, feedback: 'Shorter'}};
  assert.equal(promptFor(request).instructions, promptFor(refine).instructions);
  assert.equal(composerRequest({...request, history: ['injected'], contextKey: 'injected'}).history, undefined);
  const opts = commandOptions(request, {token, workdir: '/tmp/fixture', streaming: true});
  assert.equal(opts.args[opts.args.indexOf('--input-format') + 1], 'stream-json');
  assert.ok(opts.args.includes('--safe-mode'));
  assert.ok(opts.args.includes('--no-session-persistence'));
  assert.ok(!opts.args.includes('--disable-slash-commands'), '/clear must remain available');
  assert.equal(opts.args[opts.args.indexOf('--tools') + 1], '');
  assert.equal(opts.args[opts.args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.deepEqual(JSON.parse(opts.args[opts.args.indexOf('--settings') + 1]).enabledPlugins, {});
  const check = {...request, assessment: {text: variants[0].text}};
  assert.equal(claudePromptFor(check).instructions, claudePromptFor(request).instructions);
  assert.deepEqual(commandOptions(check, {token, workdir: '/tmp/fixture', streaming: true}).args, opts.args);
});

test('sessions reuse successful turns, clear at the idle boundary and cap continuous conversations', async () => {
  let now = 0, clears = 0, closes = 0;
  const session = new ComposerSession({now: () => now, idleMs: 120000, maxTurns: 2});
  const seen = [];
  const operation = async value => { seen.push(structuredClone({history: value.history, cacheKey: value.cacheKey})); return output; };
  const hooks = {clear: async () => { clears++; }, close: async () => { closes++; }};
  try {
    await session.run('tab-a', 'first', operation, hooks);
    await session.run('tab-a', 'refine', operation, hooks);
    assert.equal(seen[1].history[0].content, 'first');
    assert.equal(seen[0].cacheKey, seen[1].cacheKey);
    await session.run('tab-a', 'third', operation, hooks);
    assert.equal(clears, 1);
    assert.equal(seen[2].history.length, 0);
    now = 120000;
    await session.run('tab-a', 'later', operation, hooks);
    assert.equal(clears, 2); assert.equal(seen[3].history.length, 0);
    await session.run('tab-b', 'different tab', operation, hooks);
    assert.equal(closes, 1); assert.equal(seen[4].history.length, 0);
    assert.notEqual(seen[4].cacheKey, seen[3].cacheKey);
  } finally { await session.reset(); }
});

test('idle clearing runs without a new request and next work waits for the reset acknowledgement', async () => {
  const session = new ComposerSession({idleMs: 15});
  let acknowledge, cleared;
  const clearing = new Promise(resolve => { cleared = resolve; });
  try {
    await session.run('scope', 'one', async () => output, {
      clear: () => { cleared(); return new Promise(resolve => { acknowledge = resolve; }); },
    });
    // Keep this test alive while the production idle timer is deliberately unref'd.
    const keepAlive = setTimeout(() => {}, 1000);
    await clearing; clearTimeout(keepAlive);
    let ran = false;
    const next = session.run('scope', 'two', async ({history}) => {
      ran = true; assert.equal(history.length, 0); return output;
    });
    await tick(); assert.equal(ran, false);
    acknowledge(); await next;
  } finally { acknowledge?.(); await session.reset(); }
});

test('reset cancels active work and never commits its late response or failed output', async () => {
  const session = new ComposerSession();
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const running = session.run('scope', 'private draft', () => {
    started(); return new Promise(resolve => { release = resolve; });
  });
  const rejected = assert.rejects(running);
  await ready;
  await session.reset(); release(output); await rejected;
  assert.deepEqual(session.history, []);
  await assert.rejects(session.run('scope', 'bad', async () => { throw new Error('failure'); }));
  await session.run('scope', 'fresh', async ({history}) => { assert.equal(history.length, 0); return output; });
  await session.reset();
});

test('context character limits reset without waiting for the turn limit', async () => {
  const session = new ComposerSession({maxCharacters: 10});
  let clears = 0;
  try {
    await session.run('scope', 'first', async () => output, {clear: async () => { clears++; }});
    await session.run('scope', 'second', async ({history}) => {
      assert.equal(history.length, 0); return output;
    }, {clear: async () => { clears++; }});
    assert.equal(clears, 1);
  } finally { await session.reset(); }
});

test('reset during an awaited idle clear prevents the queued draft from running', async () => {
  let now = 0, release;
  const session = new ComposerSession({now: () => now, idleMs: 1000});
  const hooks = {
    clear: () => new Promise(resolve => { release = resolve; }),
  };
  await session.run('scope', 'first', async () => output, hooks);
  now = 1000;
  let ran = false;
  const queued = session.run('scope', 'stale', async () => { ran = true; return output; }, hooks);
  const rejected = assert.rejects(queued, error => error.code === 'cancelled');
  await tick();
  const reset = session.reset();
  release();
  await reset; await rejected;
  assert.equal(ran, false); assert.deepEqual(session.history, []);
});

async function fixture(mode = '') {
  const directory = await mkdtemp(path.join(tmpdir(), 'streamir-warm-cli-'));
  await symlink(process.execPath, path.join(directory, 'claude'));
  const file = path.join(directory, 'fixture.mjs');
  await writeFile(file, `
    import {createInterface} from 'node:readline';
    const mode = ${JSON.stringify(mode)}, variants = ${JSON.stringify(variants)}, assessment = ${JSON.stringify(assessment)};
    let turns = 0;
    const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
    for await (const line of createInterface({input:process.stdin})) {
      const value = JSON.parse(line);
      if (value.type === 'control_request') {
        if (value.request.skills.length) process.exit(2);
        send({type:'control_response',response:{subtype:'success',request_id:value.request_id,
          response:{commands:mode === 'old' ? [] : [{name:'clear'}]}}});
        send({type:'system',subtype:'init',tools:[],mcp_servers:[],plugins:mode === 'plugin' ? ['unexpected'] : [],
          skills:[],slash_commands:mode === 'old' ? [] : ['clear']});
      } else if (value.message.content === '/clear') {
        if (value.client_composed) process.exit(3);
        if (mode === 'unconfirmed') { send({type:'result',subtype:'error_during_execution',is_error:true}); continue; }
        turns = 0;
        send({type:'conversation_reset',new_conversation_id:'new-context',session_id:'old-context'});
        send({type:'result',subtype:'success',is_error:false});
      } else {
        if (!value.client_composed) process.exit(4);
        const input = JSON.parse(value.message.content);
        if (input.draft === 'Wait') { send({type:'system',subtype:'waiting'}); continue; }
        if (mode === 'overflow') { process.stdout.write('x'.repeat(524289)); continue; }
        turns++;
        send({type:'result',subtype:'success',is_error:false,
          structured_output:input.assess ? {variants:[],assessment} :
            {variants:(input.selected ? variants.slice(0,1) : variants).map(v=>({...v,meaning:'Turn '+turns})),assessment:null},
          usage:{cache_read_input_tokens:turns > 1 ? 512 : 0,cache_creation_input_tokens:512}});
      }
    }
  `);
  const children = [], messages = [], workdirs = [];
  const local = new LocalClaude({directories: [directory], launch: (executable, args, options) => {
    workdirs.push(options.cwd);
    const child = spawn(executable, [file, ...args], options);
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = value => { messages.push(JSON.parse(value)); return write(value); };
    children.push(child); return child;
  }});
  return {local, children, messages, workdirs, async cleanup() {
    await local.close(); await rm(directory, {recursive: true, force: true});
  }};
}

test('one live Claude process serves suggestions and refinement, then /clear starts fresh on that process', {timeout: 5000}, async () => {
  const f = await fixture();
  const call = value => f.local.suggest(value, {token, signal: new AbortController().signal});
  try {
    assert.equal((await call(request)).variants[0].meaning, 'Turn 1');
    const second = await call({...request, refinement: {text: variants[0].text, feedback: 'Shorter'}});
    assert.equal(second.variants.length, 1); assert.equal(second.variants[0].meaning, 'Turn 2');
    assert.equal(second.cache.readTokens, 512);
    assert.equal(f.children.length, 1);
    await f.local.clear();
    assert.equal(f.messages.at(-1).message.content, '/clear');
    assert.equal((await call(request)).variants[0].meaning, 'Turn 1');
    assert.equal(f.children.length, 1, 'confirmed /clear keeps the process warm');
    await f.local.close();
    await assert.rejects(access(f.workdirs[0]), {code: 'ENOENT'});
  } finally { await f.cleanup(); }
});
test('a selected-version assessment reuses the same slim Claude process without becoming a translation', {timeout: 5000}, async () => {
  const f = await fixture();
  const service = new ComposerService({read: async () => ({apiKeys: {}, accounts: [], models: {}}), write: async () => {}},
    {claude: f.local});
  try {
    await service.initialize();
    const call = value => service.handle({type: 'suggest', request: value, contextKey: 'viewer', claudeToken: token});
    await call(request);
    const result = await call({...request, assessment: {text: variants[0].text}});
    assert.deepEqual(result.assessment, assessment); assert.equal(result.variants, undefined);
    assert.equal(f.children.length, 1);
    assert.equal(service.session.history.length, 2, 'API history never retains assessment instructions or output');
    assert.equal(service.session.turns, 2, 'Checks still count towards context bounds');
    const refined = await call({...request, refinement: {text: variants[0].text, feedback: 'Shorter'}});
    assert.equal(refined.variants.length, 1); assert.equal(refined.variants[0].meaning, 'Turn 3');
    assert.equal(f.children.length, 1);
    await service.session.clear();
    assert.equal(f.messages.at(-1).message.content, '/clear');
  } finally { await service.close(); await f.cleanup(); }
});

test('unsupported or unconfirmed /clear discards the process before another draft', {timeout: 5000}, async () => {
  for (const mode of ['old', 'unconfirmed']) {
    const f = await fixture(mode);
    try {
      await f.local.suggest(request, {token});
      await f.local.clear();
      assert.equal(f.local.process, null);
      const result = await f.local.suggest(request, {token});
      assert.equal(result.variants[0].meaning, 'Turn 1'); assert.equal(f.children.length, 2);
      if (mode === 'old') assert.ok(!f.messages.some(m => m.message?.content === '/clear'));
    } finally { await f.cleanup(); }
  }
});

test('a token change restarts Claude; cancellation kills it and drops the temporary directory', {timeout: 5000}, async () => {
  const f = await fixture();
  try {
    await f.local.suggest(request, {token});
    await f.local.suggest(request, {token: token + 'x'});
    assert.equal(f.children.length, 2);
    const controller = new AbortController();
    const running = f.local.suggest({...request, text: 'Wait'}, {token: token + 'x', signal: controller.signal});
    const rejected = assert.rejects(running, e => e.code === 'cancelled');
    await tick(); controller.abort(); await rejected;
    assert.equal(f.local.process, null);
    for (const dir of f.workdirs) await assert.rejects(access(dir), {code: 'ENOENT'});
  } finally { await f.cleanup(); }
});

test('unexpected plugins and oversized stream output fail closed', {timeout: 5000}, async () => {
  for (const mode of ['plugin', 'overflow']) {
    const f = await fixture(mode);
    try {
      await assert.rejects(f.local.suggest(request, {token}), error => ['claude-missing', 'response'].includes(error.code));
      assert.equal(f.local.process, null);
    } finally { await f.cleanup(); }
  }
});

test('OpenAI reuses bounded context and cache keys without storing responses or crossing scope/account/model', async () => {
  let now = 0;
  const bodies = [];
  const state = {hostId: 'test', apiKeys: {'openai-api': 'fixture-key'}, models: {'openai-api': 'test-model'},
    accounts: [
      {id: 'a', accessToken: 'fixture-a', refreshToken: 'refresh-a', expiresAt: Date.now() + 3600000},
      {id: 'b', accessToken: 'fixture-b', refreshToken: 'refresh-b', expiresAt: Date.now() + 3600000},
    ], activeAccount: 'a'};
  const service = new ComposerService({read: async () => state, write: async () => {}}, {
    sessionOptions: {now: () => now}, fetchImpl: async (url, options) => {
      if (url.endsWith('/models')) return Response.json({
        data: [{id: 'gpt-test'}, {id: 'gpt-other'}],
        models: [{slug: 'gpt-test', display_name: 'Test', visibility: 'list'}],
      });
      const body = JSON.parse(options.body); bodies.push(body);
      assert.equal(body.store, false); assert.equal(body.previous_response_id, undefined);
      assert.equal(body.conversation, undefined); assert.equal(body.tools, undefined);
      assert.equal(body.prompt_cache_retention, undefined);
      const input = JSON.parse(body.input.at(-1).content);
      const response = {variants: input.selected ? variants.slice(0, 1) : variants};
      return new Response([
        `data: ${JSON.stringify({type: 'response.output_text.delta', delta: JSON.stringify(response)})}\n\n`,
        `data: ${JSON.stringify({type: 'response.completed', response: {status: 'completed',
          usage: {input_tokens_details: {cached_tokens: 512}}}})}\n\n`,
      ].join(''));
    },
  });
  await service.initialize();
  state.models['openai-api'] = 'gpt-test';
  const call = (changes = {}, contextKey = 'tab-a') => service.handle({type: 'suggest', contextKey,
    request: {...request, provider: 'openai-api', ...changes}});
  try {
    await call();
    const refinement = await call({refinement: {text: variants[0].text, feedback: 'Shorter'}});
    assert.equal(refinement.variants.length, 1); assert.equal(refinement.cache.readTokens, 512);
    assert.equal(refinement.timing.sessionTurn, 2);
    assert.equal(bodies[1].input.length, 3); assert.deepEqual(bodies[1].input[0], bodies[0].input[0]);
    assert.equal(bodies[1].instructions, bodies[0].instructions);
    assert.equal(bodies[1].prompt_cache_key, bodies[0].prompt_cache_key);
    now = 120000; await call();
    assert.equal(bodies.at(-1).input.length, 1);
    await call({}, 'tab-b'); assert.equal(bodies.at(-1).input.length, 1);
    await service.handle({type: 'select-model', provider: 'openai-api', model: 'gpt-other'});
    await call({}, 'tab-b'); assert.equal(bodies.at(-1).input.length, 1);
    await service.handle({type: 'select-model', provider: 'openai-chatgpt', model: 'gpt-test'});
    await call({provider: 'openai-chatgpt'});
    assert.equal(bodies.at(-1).max_output_tokens, undefined);
    await service.handle({type: 'select-account', accountId: 'b'});
    await service.handle({type: 'select-model', provider: 'openai-chatgpt', model: 'gpt-test'});
    await call({provider: 'openai-chatgpt'});
    assert.equal(bodies.at(-1).input.length, 1);
    assert.ok(!JSON.stringify(state).includes('Hello everyone'), 'conversation is never written to the credential store');
  } finally { await service.close(); }
});
