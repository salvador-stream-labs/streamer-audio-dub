import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import xterm from '@xterm/headless';
import {ComposerError, claudeToken} from '../src/composer/contract.js';
import {claudeAuthorizeURL, claudeAuthorizationCode} from '../src/composer/claude-auth.js';

const {Terminal} = xterm;
const COLS = 400, ROWS = 60;
const command = 'stty cols 400 rows 60 -echo; exec "$STREAMIR_CLAUDE_EXECUTABLE" setup-token';

export function terminalCommand(executable, directory, platform = process.platform) {
  if (!['darwin', 'linux'].includes(platform)) throw new ComposerError('claude-login');
  return {
    // Node's "pipe" is a socket on macOS; BSD script rejects that on stdin.
    // cat supplies a real POSIX pipe. Both shell programs are fixed source;
    // the executable path is expanded only as one quoted environment argument.
    file: platform === 'darwin' ? '/bin/sh' : '/usr/bin/script',
    args: platform === 'darwin'
      ? ['-c', `cat | /usr/bin/script -q /dev/null /bin/sh -c '${command}'`]
      : ['-qefc', command, '/dev/null'],
    options: {
      cwd: directory, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: homedir(), TMPDIR: directory, CLAUDE_CONFIG_DIR: directory,
        STREAMIR_CLAUDE_EXECUTABLE: executable, BROWSER: '/usr/bin/true',
        TERM: 'xterm-256color', LANG: 'en_US.UTF-8', SHELL: '/bin/sh',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    },
  };
}
export function renderedText(terminal) {
  let text = '';
  const buffer = terminal.buffer.active;
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (line) text += (line.isWrapped ? '' : '\n') + line.translateToString(true);
  }
  return text;
}

// One local interactive CLI session, owned by one connected settings page.
// Never log or persist terminal output, authorization codes or generated tokens.
export class ClaudeLogin {
  constructor({launch = spawn, platform = process.platform, ttl = 600000, startTimeout = 30000,
    finishTimeout = 60000, pollInterval = 100} = {}) {
    Object.assign(this, {launch, platform, ttl, startTimeout, finishTimeout, pollInterval});
  }
  async start(executable, signal) {
    signal.throwIfAborted();
    if (this.session) throw new ComposerError('busy');
    const session = this.session = {id: randomUUID(), phase: 'starting', pendingWrites: 0, bytes: 0, dead: false};
    try {
      session.directory = await mkdtemp(path.join(tmpdir(), 'streamir-claude-login-'));
      signal.throwIfAborted();
      session.terminal = new Terminal({cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true});
      const {file, args, options} = terminalCommand(executable, session.directory, this.platform);
      const child = session.child = this.launch(file, args, options);
      session.exit = new Promise(resolve => {
        child.once('error', () => { session.dead = true; resolve(); });
        child.once('close', () => { session.dead = true; resolve(); });
      });
      child.stdin.on('error', () => { session.failed = true; });
      const collect = chunk => {
        if (session.closing) return;
        session.bytes += Buffer.byteLength(chunk);
        if (session.bytes > 1048576) { session.failed = true; void this.cancel(session.id); return; }
        session.pendingWrites++;
        session.terminal.write(chunk, () => { session.pendingWrites--; });
      };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      session.timer = setTimeout(() => void this.cancel(session.id), this.ttl);
      session.timer.unref?.();
      const url = await this.wait(session, text => {
        if (/OAuth\s*error/i.test(text)) throw new ComposerError('claude-login');
        const candidate = text.match(/https:\/\/[^\s]*?\/oauth\/authorize[^\s]*?(?=https:\/\/|\s|$)/)?.[0];
        if (!candidate) return;
        try { return claudeAuthorizeURL(candidate); } catch { return; }
      }, this.startTimeout, signal);
      session.phase = 'waiting';
      return {sessionId: session.id, url};
    } catch (error) { await this.cancel(session.id); throw error; }
  }
  async finish(id, value, signal) {
    const session = this.session;
    if (!session || session.id !== id || session.phase !== 'waiting' || session.closing) throw new ComposerError('claude-session');
    const code = claudeAuthorizationCode(value);
    session.phase = 'finishing';
    try {
      signal.throwIfAborted();
      if (session.dead) throw new ComposerError('claude-session');
      session.child.stdin.write(code);
      // Ink must apply the input update before processing Enter.
      await delay(150, undefined, {signal});
      session.child.stdin.write('\r');
      const token = await this.wait(session, text => {
        if (/OAuth\s*error|invalid authorization code/i.test(text)) throw new ComposerError('claude-code');
        // Require a terminating character, never a token truncated at a chunk boundary.
        const candidate = text.match(/sk-ant-oat01-[A-Za-z0-9_-]{20,}(?=[^A-Za-z0-9_-])/)?.[0];
        return candidate ? claudeToken(candidate) : undefined;
      }, this.finishTimeout, signal);
      return {claudeToken: token};
    } finally { await this.cancel(id); }
  }
  async wait(session, read, timeout, signal) {
    const deadline = Date.now() + timeout;
    let previous;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (session.closing) throw new ComposerError('claude-session');
      if (session.failed) throw new ComposerError('claude-login');
      if (!session.pendingWrites) {
        const value = read(renderedText(session.terminal));
        if (value && (value === previous || session.dead)) return value;
        previous = value;
        if (session.dead) throw new ComposerError('claude-login');
      }
      await delay(this.pollInterval, undefined, {signal});
    }
    throw new ComposerError('claude-session');
  }
  async cancel(id = this.session?.id) {
    const session = this.session;
    if (!session || session.id !== id) return {cancelled: true};
    if (session.closing) return session.closing;
    session.closing = (async () => {
      clearTimeout(session.timer);
      const child = session.child;
      if (child && !session.dead) {
        // Closing the PTY also hangs up its foreground command. No shell input
        // from the browser is interpreted; stdin contains only a validated code.
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        child.stdin.destroy();
        await session.exit;
      }
      session.terminal?.dispose();
      session.terminal = null;
      if (session.directory) await rm(session.directory, {recursive: true, force: true});
      if (this.session === session) this.session = null;
      return {cancelled: true};
    })();
    return session.closing;
  }
}
