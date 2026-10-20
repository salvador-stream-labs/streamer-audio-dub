import {spawn} from 'node:child_process';
import {access, stat, mkdtemp, rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {ComposerError, composerRequest, claudeToken, claudeOutputSchema, claudePromptFor, variants, assessment} from '../src/composer/contract.js';
import {ClaudeLogin} from './claude-login.mjs';

export function searchDirectories(saved = []) {
  return [...new Set([
    path.join(homedir(), '.local/bin'), path.dirname(process.execPath),
    '/opt/homebrew/bin', '/usr/local/bin',
    ...saved, ...(process.env.PATH ?? '').split(path.delimiter),
  ].filter(value => typeof value === 'string' && path.isAbsolute(value)))].slice(0, 100);
}
export async function findExecutable(directories) {
  for (const directory of directories) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, 'claude');
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}
export function commandOptions(value, {token, workdir, streaming = false}) {
  const request = composerRequest(value), {instructions, input} = claudePromptFor(request);
  return {
    input,
    args: ['--print', '--output-format', streaming ? 'stream-json' : 'json',
      ...(streaming ? ['--input-format', 'stream-json', '--verbose'] : []),
      '--json-schema', JSON.stringify(claudeOutputSchema()),
      '--model', 'claude-haiku-5-5', '--effort', 'low', '--max-turns', '3',
      '--system-prompt', instructions, '--tools', '', '--restricted', '--safe-mode', '--no-chrome',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', '', '--settings', JSON.stringify({disableAllHooks: true,
        disableClaudeAiConnectors: true, disableBundledSkills: true, autoMemoryEnabled: false, enabledPlugins: {}}),
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--no-session-persistence'],
    // Do not inherit API keys, gateway overrides, project hooks or cached logins.
    // --bare is deliberately omitted: it disables subscription authentication.
    env: {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: homedir(), TMPDIR: workdir, CLAUDE_CONFIG_DIR: workdir,
      CLAUDE_CODE_OAUTH_TOKEN: claudeToken(token),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096',
    },
  };
}
// JSON-lines transport to the installed CLI. stdin remains open between turns;
// only our idle controller can dispatch /clear. Drafts are verbatim JSON data.
export class ClaudeProcess {
  constructor(executable, options, launch = spawn) {
    this.child = launch(executable, options.args, {cwd: options.workdir, env: options.env,
      stdio: ['pipe', 'pipe', 'pipe']});
    this.buffer = ''; this.stderr = ''; this.bytes = 0; this.closed = false;
    const child = this.child;
    this.exited = new Promise(resolve => {
      child.once('close', () => {
        this.closed = true;
        let error = new ComposerError('response');
        try { parseResult('', this.stderr, 1, false); } catch (failure) { error = failure; }
        this.settle(error); resolve();
      });
      child.once('error', () => {
        this.closed = true; this.settle(new ComposerError('claude-missing')); resolve();
      });
    });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => this.read(chunk));
    child.stderr.on('data', chunk => {
      this.bytes += Buffer.byteLength(chunk);
      if (this.bytes > 524288) { void this.close(new ComposerError('response')); return; }
      this.stderr = (this.stderr + chunk).slice(-4096);
    });
    child.stdin.on('error', () => { void this.close(new ComposerError('response')); });
  }
  settle(error, value) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null; pending.cleanup();
    if (error) pending.reject(error); else pending.resolve(value);
  }
  read(chunk) {
    if (this.closed) return;
    this.bytes += Buffer.byteLength(chunk); this.buffer += chunk;
    if (this.bytes > 524288) { void this.close(new ComposerError('response')); return; }
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      try { this.message(JSON.parse(line)); }
      catch (error) { void this.close(error instanceof ComposerError ? error : new ComposerError('response')); return; }
    }
  }
  message(item) {
    if (item.type === 'system' && item.subtype === 'init') {
      // StructuredOutput is the CLI's schema formatter, not an external tool.
      if (item.tools?.some(name => name !== 'StructuredOutput') || item.mcp_servers?.length ||
        item.plugins?.length || item.skills?.length) throw new ComposerError('claude-missing');
      this.canClear = item.slash_commands?.includes('clear') ?? this.canClear;
    }
    const pending = this.pending;
    if (!pending) return;
    if (item.type === 'control_request') {
      // No tool approvals, MCP callbacks or plugins are served by this host.
      this.child.stdin.write(JSON.stringify({type: 'control_response', response: {
        subtype: 'error', request_id: item.request_id, error: 'Tools are disabled.',
      }}) + '\n');
    } else if (pending.kind === 'initialize' && item.type === 'control_response' &&
      item.response?.request_id === pending.id) {
      if (item.response.subtype !== 'success') throw new ComposerError('claude-missing');
      this.canClear = item.response.response?.commands?.some(command => command.name === 'clear') ?? false;
      this.settle(null, {});
    } else if (pending.kind === 'clear' && item.type === 'conversation_reset') {
      if (typeof item.new_conversation_id !== 'string' || !item.new_conversation_id) throw new ComposerError('response');
      pending.reset = true;
      if (pending.result) this.settle(null, {});
    } else if (item.type === 'result' && pending.kind !== 'initialize') {
      if (pending.kind === 'clear') {
        if (item.is_error || item.subtype !== 'success') throw new ComposerError('response');
        pending.result = true;
        if (pending.reset) this.settle(null, {});
      } else {
        const value = parseResult(JSON.stringify(item), this.stderr, 0, pending.refining, pending.assessing);
        this.settle(null, {...value, cache: {
          readTokens: Number.isSafeInteger(item.usage?.cache_read_input_tokens) ? item.usage.cache_read_input_tokens : 0,
          writtenTokens: Number.isSafeInteger(item.usage?.cache_creation_input_tokens) ? item.usage.cache_creation_input_tokens : 0,
        }});
      }
    }
  }
  send(kind, content, {signal, refining = false, assessing = false, timeoutMs = 60000} = {}) {
    if (this.closed) return Promise.reject(new ComposerError('response'));
    if (this.pending) return Promise.reject(new ComposerError('busy'));
    signal?.throwIfAborted();
    this.bytes = 0; this.stderr = '';
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const abort = () => { void this.close(new ComposerError('cancelled')); };
      const timer = setTimeout(() => { void this.close(new ComposerError('timeout')); }, timeoutMs);
      this.pending = {id, kind, refining, assessing, resolve, reject, cleanup: () => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
      }};
      signal?.addEventListener('abort', abort, {once: true});
      const message = kind === 'initialize'
        ? {type: 'control_request', request_id: id, request: {subtype: 'initialize', hooks: null, skills: []}}
        : {type: 'user', uuid: id, session_id: '', parent_tool_use_id: null,
          client_composed: kind !== 'clear', message: {role: 'user', content}};
      try { this.child.stdin.write(JSON.stringify(message) + '\n'); }
      catch { void this.close(new ComposerError('response')); }
    });
  }
  async clear() {
    // Older CLIs may omit /clear. Restart instead of treating "/clear" as a
    // translation request or accepting an unconfirmed context reset.
    if (!this.canClear) { await this.close(); return; }
    try { await this.send('clear', '/clear', {timeoutMs: 5000}); }
    catch { await this.close(); }
  }
  async close(error = new ComposerError('cancelled')) {
    this.settle(error);
    if (!this.closed) {
      this.closed = true;
      this.child.stdin.destroy(); this.child.kill('SIGTERM');
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
      await this.exited; clearTimeout(timer);
    } else await this.exited;
    this.buffer = ''; this.stderr = '';
  }
}
export function parseResult(stdout, stderr, code, refining, assessing = false) {
  let result;
  try { result = JSON.parse(stdout); } catch {}
  if (code === 0 && result?.subtype === 'success' && !result.is_error) {
    return assessing ? {assessment: assessment(result.structured_output)}
      : {variants: variants(result.structured_output, refining)};
  }
  const reason = `${stderr}\n${JSON.stringify(result?.errors ?? [])}\n${result?.result ?? ''}`;
  if (/401|authentication_error|invalid.*token|oauth.*expired|not logged in/i.test(reason)) throw new ComposerError('claude-auth');
  if (/429|credit|billing|rate.?limit|usage.?limit|hit your limit/i.test(reason)) throw new ComposerError('limit');
  if (/model.*(?:not found|not available|unavailable|not supported)|do not have access to.*model/i.test(reason)) throw new ComposerError('claude-model');
  if (/unknown option|unrecognized option/i.test(reason)) throw new ComposerError('claude-missing');
  throw new ComposerError('response');
}
export function runClaude(value, {token, workdir, executable, signal}, launch = spawn) {
  const request = composerRequest(value), {args, env, input} = commandOptions(request, {token, workdir});
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = launch(executable, args, {cwd: workdir, env, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '', stderr = '', size = 0, overflow = false, killTimer;
    const stop = () => {
      child.kill('SIGTERM');
      killTimer ||= setTimeout(() => child.kill('SIGKILL'), 2000);
    };
    const clean = () => { signal.removeEventListener('abort', stop); clearTimeout(killTimer); };
    const collect = (chunk, error) => {
      size += Buffer.byteLength(chunk);
      if (size > 524288) { overflow = true; stop(); return; }
      if (error) stderr += chunk; else stdout += chunk;
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => collect(chunk, false));
    child.stderr.on('data', chunk => collect(chunk, true));
    child.stdin.on('error', () => {});
    child.on('error', () => { clean(); reject(new ComposerError('claude-missing')); });
    child.on('close', code => {
      clean();
      if (signal.aborted) { reject(signal.reason); return; }
      if (overflow) { reject(new ComposerError('response')); return; }
      try { resolve(parseResult(stdout, stderr, code, Boolean(request.refinement), Boolean(request.assessment))); } catch (error) { reject(error); }
    });
    signal.addEventListener('abort', stop, {once: true});
    if (signal.aborted) stop(); else child.stdin.end(input);
  });
}
export class LocalClaude {
  constructor({directories = searchDirectories(), platform = process.platform, launch = spawn, login} = {}) {
    this.directories = directories; this.platform = platform; this.launch = launch;
    this.login = login ?? new ClaudeLogin({platform});
  }
  async detect() {
    const executable = await findExecutable(this.directories);
    return {available: Boolean(executable), executable,
      canSignIn: Boolean(executable) && ['darwin', 'linux'].includes(this.platform)};
  }
  async generateToken(signal) {
    const {executable, canSignIn} = await this.detect();
    if (!executable) throw new ComposerError('claude-missing');
    if (!canSignIn) throw new ComposerError('claude-login');
    return this.login.start(executable, signal);
  }
  async suggest(request, {token, signal}) {
    request = composerRequest(request);
    claudeToken(token);
    signal?.throwIfAborted();
    const identity = createHash('sha256').update(token).update(claudePromptFor(request).instructions).digest('hex');
    if (this.process?.closed || this.identity !== identity) await this.close();
    try {
      if (!this.process) {
        const {executable} = await this.detect();
        if (!executable) throw new ComposerError('claude-missing');
        this.workdir = await mkdtemp(path.join(tmpdir(), 'streamir-claude-'));
        this.identity = identity;
        const options = commandOptions(request, {token, workdir: this.workdir, streaming: true});
        this.process = new ClaudeProcess(executable, {...options, workdir: this.workdir}, this.launch);
        await this.process.send('initialize', null, {signal});
      }
      return await this.process.send('suggest', claudePromptFor(request).input,
        {signal, refining: Boolean(request.refinement), assessing: Boolean(request.assessment)});
    } catch (error) { await this.close(); throw error; }
  }
  async clear() {
    await this.process?.clear();
    if (this.process?.closed) await this.close();
  }
  async close() {
    const process = this.process, workdir = this.workdir;
    this.process = null; this.workdir = null; this.identity = null;
    await process?.close();
    if (workdir) await rm(workdir, {recursive: true, force: true});
  }
}
