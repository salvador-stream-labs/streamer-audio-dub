import {ComposerError, composerRequest, outputSchema, assessmentSchema, assessment, promptFor, variants} from '../src/composer/contract.js';

const MAX_BODY = 512 * 1024;
function statusError(status) {
  return new ComposerError(status === 401 || status === 403 ? 'auth' : status === 429 ? 'limit' : status === 404 ? 'model' : 'response');
}
export async function readJSON(response) {
  if (!response.ok) { await response.body?.cancel(); throw statusError(response.status); }
  const reader = response.body.getReader();
  let bytes = 0, text = '';
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_BODY) throw new ComposerError('response');
      text += decoder.decode(value, {stream: true});
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof ComposerError) throw error;
    throw new ComposerError('response');
  } finally { reader.releaseLock(); }
}

export async function readResponsesStream(response, onUsage = () => {}) {
  if (!response.ok) { await response.body?.cancel(); throw statusError(response.status); }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', text = '', completed = false, bytes = 0;
  function event(block) {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const item = JSON.parse(data);
    if (item.type === 'response.output_text.delta') text += item.delta ?? '';
    else if (item.type === 'response.refusal.delta' || item.type === 'response.refusal.done') throw new ComposerError('refused');
    else if (item.type === 'response.completed') {
      if (item.response?.status !== 'completed') throw new ComposerError('response');
      completed = true;
      onUsage(item.response.usage);
    } else if (['error', 'response.failed', 'response.incomplete'].includes(item.type)) {
      const code = item.code ?? item.error?.code ?? item.response?.error?.code ?? '';
      throw new ComposerError(/usage|quota|rate_limit/.test(code) ? 'limit' : 'response');
    }
  }
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) { buffer += decoder.decode(); break; }
      bytes += value.length;
      if (bytes > MAX_BODY) throw new ComposerError('response');
      buffer += decoder.decode(value, {stream: true});
      // Normalize after joining chunks, including CRLF split between chunks.
      buffer = buffer.replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        event(buffer.slice(0, end)); buffer = buffer.slice(end + 2);
      }
    }
    if (buffer.trim()) event(buffer.replace(/\r\n/g, '\n'));
    if (!completed || !text) throw new ComposerError('response');
    return JSON.parse(text);
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof ComposerError) throw error;
    throw new ComposerError('response');
  } finally { reader.releaseLock(); }
}

export async function listOpenAIModels(token, subscription, {fetchImpl = fetch, signal} = {}) {
  const response = await fetchImpl('https://api.openai.com/v1/models', {
    headers: {Authorization: `Bearer ${token}`}, signal, redirect: 'error',
  });
  const body = await readJSON(response);
  const models = subscription
    ? body.models?.filter(item => item.visibility === 'list').map(item => ({id: item.slug, label: item.display_name}))
    : body.data?.filter(item => /^gpt-/.test(item.id) && !/audio|realtime|image|transcrib|tts|instruct|search/.test(item.id))
      .map(item => ({id: item.id, label: item.id})).sort((a, b) => a.id.localeCompare(b.id));
  if (!models?.length || models.some(m => typeof m.id !== 'string' || !m.id || m.id.length > 150 || typeof m.label !== 'string')) throw new ComposerError('model');
  return models;
}

export async function suggest(value, {token, model, signal, fetchImpl = fetch, history = [], cacheKey}) {
  const request = composerRequest(value), prompt = promptFor(request);
  const schema = request.assessment ? assessmentSchema() : outputSchema();
  // A judgment is independent of earlier drafts and must not inherit their
  // assumptions or editing instructions.
  if (request.assessment) { history = []; if (cacheKey) cacheKey += ':assessment'; }
  if (typeof token !== 'string' || !token) throw new ComposerError('auth');
  const combinedSignal = AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]);
  try {
    let body, cache;
    if (request.provider === 'anthropic') {
      const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: combinedSignal, redirect: 'error',
        headers: {'Content-Type': 'application/json', 'x-api-key': token, 'anthropic-version': '2023-06-01'},
        body: JSON.stringify({
          model: 'claude-haiku-5-5', max_tokens: 4096,
          system: [{type: 'text', text: prompt.instructions, cache_control: {type: 'ephemeral'}}],
          cache_control: {type: 'ephemeral'},
          messages: [...history, {role: 'user', content: prompt.input}],
          output_config: {effort: 'low', format: {type: 'json_schema', schema}},
        }),
      });
      const data = await readJSON(response);
      if (data.stop_reason === 'refusal') throw new ComposerError('refused');
      if (data.stop_reason !== 'end_turn') throw new ComposerError('response');
      body = JSON.parse(data.content?.filter(block => block.type === 'text').map(block => block.text).join(''));
      if (data.usage) cache = {
        readTokens: safeTokens(data.usage.cache_read_input_tokens),
        writtenTokens: safeTokens(data.usage.cache_creation_input_tokens),
      };
    } else {
      if (typeof model !== 'string' || !model || model.length > 150) throw new ComposerError('model');
      const response = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST', signal: combinedSignal, redirect: 'error',
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
        body: JSON.stringify({
          model, instructions: prompt.instructions, input: [...history, {role: 'user', content: prompt.input}],
          store: false, stream: true,
          ...(cacheKey ? {prompt_cache_key: cacheKey} : {}),
          // Subscription usage rejects max_output_tokens and sampling fields.
          ...(request.provider === 'openai-api' ? {max_output_tokens: 4096} : {}),
          text: {format: {type: 'json_schema', name: request.assessment ? 'chat_assessment' : 'chat_versions', strict: true, schema}},
        }),
      });
      body = await readResponsesStream(response, usage => {
        if (usage) cache = {readTokens: safeTokens(usage.input_tokens_details?.cached_tokens)};
      });
    }
    return {...(request.assessment ? {assessment: assessment(body)} : {variants: variants(body, Boolean(request.refinement))}),
      ...(cache ? {cache} : {})};
  } catch (error) {
    if (combinedSignal.aborted) throw new ComposerError(signal?.aborted ? 'cancelled' : 'timeout');
    if (error instanceof ComposerError) throw error;
    throw new ComposerError(error instanceof SyntaxError ? 'response' : 'network');
  }
}
const safeTokens = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
