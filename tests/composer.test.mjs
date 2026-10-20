import test from 'node:test';
import assert from 'node:assert/strict';
import {composerRequest, composerPreferences, assessment, promptFor, variants} from '../src/composer/contract.js';
import {suggest, readResponsesStream, listOpenAIModels} from '../native/providers.mjs';
import {ComposerService} from '../native/service.mjs';

const result = {variants: [
  {label: 'Natural', text: 'Привет всем!', meaning: 'Hi everyone!'},
  {label: 'Casual', text: 'Всем привет!', meaning: 'Hey everyone!'},
  {label: 'Warm', text: 'Рад всех видеть!', meaning: 'Good to see everyone!'},
]};
const request = {provider: 'anthropic', text: 'Hi everyone!', sourceLanguage: 'en', targetLanguage: 'ru'};
const check = {assessment: {
  summary: 'Friendly, with a reference that may need context.',
  naturalness: 'The phrasing is grammatical but slightly formal for chat.',
  tone: 'It may sound more solemn than the original.',
  references: 'The named TV joke depends on shared familiarity, not language alone.',
  suggestion: 'Keep the greeting, but explain the joke briefly.',
}};
function events(items, chunkSize = 17) {
  const bytes = new TextEncoder().encode(items.map(item => `data: ${JSON.stringify(item)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({start(controller) {
    for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
    controller.close();
  }}));
}
const responseEvents = data => [
  {type: 'response.output_text.delta', delta: JSON.stringify(data)},
  {type: 'response.completed', response: {status: 'completed'}},
];
test('composer whitelists payloads and rejects unsafe or duplicate output', () => {
  assert.deepEqual(composerRequest({...request, apiKey: 'must not forward', history: ['private']}), request);
  assert.throws(() => composerRequest({...request, targetLanguage: 'en'}));
  assert.throws(() => composerRequest({...request, text: 'x'.repeat(501)}));
  assert.throws(() => composerRequest({...request, provider: 'unknown'}));
  for (const text of ['/ban someone', '.ban someone', '\u200b/ban someone']) {
    assert.throws(() => variants({variants: [{...result.variants[0], text}, ...result.variants.slice(1)]}));
  }
  assert.throws(() => variants({variants: [result.variants[0], result.variants[0], result.variants[2]]}));
});
test('assessment is opt-in, bounded, distinct from refinement and never accepts injected history', () => {
  for (const value of [undefined, {}, {assessmentEnabled: 'true'}, {assessmentEnabled: 1}]) {
    assert.equal(composerPreferences(value).assessmentEnabled, false);
  }
  assert.equal(composerPreferences({assessmentEnabled: true}).assessmentEnabled, true);
  const value = composerRequest({...request, assessment: {text: 'Привет!', history: ['private']}, history: ['private']});
  assert.deepEqual(value.assessment, {text: 'Привет!'}); assert.equal(value.history, undefined);
  assert.throws(() => composerRequest({...value, refinement: {text: 'Привет!', feedback: 'Shorter'}}));
  assert.throws(() => composerRequest({...value, assessment: {text: 'x'.repeat(501)}}));
  assert.deepEqual(assessment(check), check.assessment);
  for (const invalid of [{}, {assessment: {...check.assessment, tone: ''}},
    {assessment: {...check.assessment, summary: 'x'.repeat(351)}},
    {assessment: {...check.assessment, references: '\u202eevil'}}]) {
    assert.throws(() => assessment(invalid), error => error.code === 'response');
  }
  const prompt = promptFor(value);
  assert.deepEqual(JSON.parse(prompt.input), {draft: request.text, selected: 'Привет!'});
  assert.match(prompt.instructions, /Language does not establish nationality/);
  assert.match(prompt.instructions, /explanation in English/);
});
test('each API route assesses only the selected wording with an independent structured response', async () => {
  for (const provider of ['anthropic', 'openai-api', 'openai-chatgpt']) {
    let calls = 0;
    const value = await suggest({...request, provider, assessment: {text: 'Привет!'}}, {
      token: 'test', model: 'chosen-model', cacheKey: 'scope',
      history: [{role: 'user', content: 'An unrelated private draft'}],
      fetchImpl: async (_, options) => {
        calls++;
        const body = JSON.parse(options.body);
        const messages = provider === 'anthropic' ? body.messages : body.input;
        assert.equal(messages.length, 1);
        assert.deepEqual(JSON.parse(messages[0].content), {draft: request.text, selected: 'Привет!'});
        const schema = provider === 'anthropic' ? body.output_config.format.schema : body.text.format.schema;
        assert.deepEqual(schema.required, ['assessment']);
        assert.equal(body.tools, undefined);
        if (provider !== 'anthropic') {
          assert.equal(body.model, 'chosen-model'); assert.equal(body.prompt_cache_key, 'scope:assessment');
          assert.equal(body.store, false); assert.equal(body.stream, true);
          if (provider === 'openai-chatgpt') assert.equal(body.max_output_tokens, undefined);
        }
        return provider === 'anthropic'
          ? Response.json({stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify(check)}]})
          : events(responseEvents(check));
      },
    });
    assert.deepEqual(value, check); assert.equal(calls, 1);
  }
});
test('assessment failures cannot become chat choices or reuse partial output', async () => {
  await assert.rejects(suggest({...request, assessment: {text: 'Привет!'}}, {
    token: 'test', fetchImpl: async () =>
      Response.json({stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify(result)}]}),
  }), error => error.code === 'response');
  await assert.rejects(suggest({...request, provider: 'openai-chatgpt', assessment: {text: 'Привет!'}}, {
    token: 'test', model: 'chosen-model', fetchImpl: async () => events([
      {type: 'response.output_text.delta', delta: JSON.stringify(check)},
      {type: 'response.failed', response: {error: {code: 'subscription_sharing_usage_limit_exceeded'}}},
    ]),
  }), error => error.code === 'limit');
});
test('Anthropic calls the requested Haiku model directly with a structured schema and no chat history', async () => {
  const value = await suggest({...request, history: ['do not send']}, {
    token: 'test-api-key',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      assert.equal(options.headers['x-api-key'], 'test-api-key');
      assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'claude-haiku-5-5');
      assert.equal(body.output_config.format.type, 'json_schema');
      assert.deepEqual(body.cache_control, {type: 'ephemeral'});
      assert.deepEqual(body.system[0].cache_control, {type: 'ephemeral'});
      assert.equal(body.temperature, undefined);
      assert.equal(body.tools, undefined);
      assert.deepEqual(JSON.parse(body.messages[0].content), {draft: 'Hi everyone!'});
      return Response.json({stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify(result)}]});
    },
  });
  assert.deepEqual(value, result);
});
test('ChatGPT plan requests obey the public Responses contract and consume a complete stream', async () => {
  const value = await suggest({...request, provider: 'openai-chatgpt'}, {
    token: 'test-oauth-token', model: 'account-selected-model',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.headers.Authorization, 'Bearer test-oauth-token');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'account-selected-model');
      assert.equal(body.store, false); assert.equal(body.stream, true);
      assert.equal(body.max_output_tokens, undefined); assert.equal(body.temperature, undefined);
      assert.equal(body.input[0].role, 'user');
      assert.equal(body.text.format.strict, true);
      return events(responseEvents(result), 1);
    },
  });
  assert.deepEqual(value, result);
});
test('streamed partial results and usage failures never become insertable choices', async () => {
  await assert.rejects(readResponsesStream(events([{type: 'response.output_text.delta', delta: JSON.stringify(result)}])), e => e.code === 'response');
  await assert.rejects(readResponsesStream(events([
    responseEvents(result)[0], {type: 'response.failed', response: {error: {code: 'subscription_sharing_usage_limit_exceeded'}}},
  ])), e => e.code === 'limit');
  await assert.rejects(readResponsesStream(events([{type: 'response.refusal.delta', delta: 'refusal'}])), e => e.code === 'refused');
});
test('each refinement adds only original, selected version, and latest feedback to its turn', async () => {
  const selected = result.variants[0];
  const actual = await suggest({...request, refinement: {text: selected.text, feedback: 'Shorter', history: ['ignored']}}, {
    token: 'test',
    fetchImpl: async (_, options) => {
      assert.deepEqual(JSON.parse(JSON.parse(options.body).messages[0].content),
        {draft: request.text, selected: selected.text, feedback: 'Shorter'});
      return Response.json({stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify({variants: [selected]})}]});
    },
  });
  assert.equal(actual.variants.length, 1);
});
test('provider errors omit server bodies and credentials', async () => {
  for (const [status, code] of [[401, 'auth'], [429, 'limit'], [500, 'response']]) {
    await assert.rejects(suggest(request, {token: 'secret-test', fetchImpl: async () =>
      new Response('secret-test private draft', {status})}), error => error.code === code && !error.message.includes('secret-test'));
  }
});
test('model picker uses the subscription account catalogue, excluding hidden entries', async () => {
  const models = await listOpenAIModels('test', true, {fetchImpl: async () => Response.json({models: [
    {slug: 'visible', display_name: 'Visible model', visibility: 'list'},
    {slug: 'hidden', display_name: 'Hidden model', visibility: 'hide'},
  ]})});
  assert.deepEqual(models, [{id: 'visible', label: 'Visible model'}]);
});
test('helper status never returns credentials and refuses models not in the account catalogue', async () => {
  let stored = {hostId: 'urn:uuid:test', accounts: [{id: 'account', clientId: 'client', subject: 'subject',
    email: 'viewer@example.com', accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: Date.now() + 3600000}],
  activeAccount: 'account', apiKeys: {anthropic: 'api-secret'}, models: {}};
  const service = new ComposerService({read: async () => stored, write: async value => { stored = value; }},
    {fetchImpl: async () => Response.json({models: [{slug: 'allowed', display_name: 'Allowed', visibility: 'list'}]})});
  await service.initialize();
  assert.ok(!JSON.stringify(service.status()).includes('secret'));
  await assert.rejects(service.handle({type: 'select-model', provider: 'openai-chatgpt', model: 'invented'}, {}), e => e.code === 'model');
  await service.handle({type: 'select-model', provider: 'openai-chatgpt', model: 'allowed'}, {});
  assert.equal(stored.models['openai-chatgpt:account'], 'allowed');
});
