import {ComposerError, composerRequest, promptFor} from '../src/composer/contract.js';
import {suggest, listOpenAIModels} from './providers.mjs';
import {signIn, freshAccount, revokeAccount} from './oauth.mjs';
import {ComposerSession} from './session.mjs';
import {createHash} from 'node:crypto';

export class ComposerService {
  constructor(store, {fetchImpl = fetch, claude, sessionOptions} = {}) {
    this.store = store; this.fetchImpl = fetchImpl; this.claude = claude;
    this.catalogues = new Map();
    this.session = new ComposerSession(sessionOptions);
  }
  async initialize() {
    this.state = await this.store.read();
    await this.store.write(this.state); // Persist the host ID before the first OAuth attempt.
  }
  status() {
    const {apiKeys, accounts, activeAccount, models} = this.state;
    return {
      connected: {anthropic: Boolean(apiKeys.anthropic), 'openai-api': Boolean(apiKeys['openai-api']),
        'openai-chatgpt': Boolean(accounts.find(a => a.id === activeAccount)?.refreshToken)},
      accounts: accounts.map((a, index) => ({id: a.id, label: `${a.email || 'ChatGPT account'} · ${index + 1}`, connected: Boolean(a.refreshToken)})),
      activeAccount, models, claude: this.claudeStatus,
    };
  }
  async token(provider, signal) {
    if (provider === 'anthropic' || provider === 'openai-api') {
      const token = this.state.apiKeys[provider];
      if (!token) throw new ComposerError('auth');
      return token;
    }
    if (provider !== 'openai-chatgpt') throw new ComposerError('request');
    const index = this.state.accounts.findIndex(a => a.id === this.state.activeAccount);
    const current = this.state.accounts[index];
    const fresh = await freshAccount(current, {signal, fetchImpl: this.fetchImpl});
    if (fresh !== current) {
      this.state.accounts[index] = fresh;
      await this.store.write(this.state); // Persist rotation before making inference requests.
    }
    return fresh.accessToken;
  }
  catalogueKey(provider) { return provider === 'openai-chatgpt' ? `${provider}:${this.state.activeAccount}` : provider; }
  async catalogue(provider, signal) {
    if (!['openai-api', 'openai-chatgpt'].includes(provider)) throw new ComposerError('request');
    const token = await this.token(provider, signal);
    const models = await listOpenAIModels(token, provider === 'openai-chatgpt', {signal, fetchImpl: this.fetchImpl});
    this.catalogues.set(this.catalogueKey(provider), models);
    return models;
  }
  async resetSession(contextKey) {
    if (contextKey !== undefined && contextKey !== this.contextKey) return {reset: false};
    this.contextKey = null;
    await this.session.reset();
    return {reset: true};
  }
  async close() { await this.resetSession(); await this.claude?.close?.(); }
  async handle(message, {signal, onURL} = {}) {
    if (message.type === 'reset-session') return this.resetSession(message.contextKey);
    if (['set-key', 'remove-key', 'sign-in', 'select-account', 'sign-out', 'select-model'].includes(message.type)) {
      await this.resetSession();
    }
    if (message.type === 'status' || message.type === 'claude-detect') {
      this.claudeStatus = await this.claude?.detect() ?? {available: false};
      return this.status();
    }
    if (message.type === 'claude-login-start') {
      if (!this.claude) throw new ComposerError('claude-missing');
      return this.claude.generateToken(signal);
    }
    if (message.type === 'claude-login-finish') {
      if (!this.claude) throw new ComposerError('claude-missing');
      return this.claude.login.finish(message.sessionId, message.code, signal);
    }
    if (message.type === 'claude-login-cancel') return this.claude?.login.cancel(message.sessionId) ?? {cancelled: true};
    if (message.type === 'set-key') {
      if (!['anthropic', 'openai-api'].includes(message.provider) || typeof message.key !== 'string' ||
        !/^[\x21-\x7e]{10,4096}$/.test(message.key)) throw new ComposerError('request');
      this.state.apiKeys[message.provider] = message.key;
      delete this.state.models[message.provider];
      this.catalogues.delete(message.provider);
      await this.store.write(this.state);
      return this.status();
    }
    if (message.type === 'remove-key') {
      if (!['anthropic', 'openai-api'].includes(message.provider)) throw new ComposerError('request');
      delete this.state.apiKeys[message.provider]; delete this.state.models[message.provider];
      this.catalogues.delete(message.provider);
      await this.store.write(this.state);
      return this.status();
    }
    if (message.type === 'sign-in') {
      const account = await signIn({state: this.state, accountId: message.accountId, onURL, signal, fetchImpl: this.fetchImpl});
      const index = this.state.accounts.findIndex(a => a.id === account.id);
      if (index < 0) this.state.accounts.push(account); else this.state.accounts[index] = account;
      this.state.activeAccount = account.id;
      await this.store.write(this.state);
      return this.status();
    }
    if (message.type === 'select-account') {
      if (!this.state.accounts.some(a => a.id === message.accountId)) throw new ComposerError('auth');
      this.state.activeAccount = message.accountId;
      await this.store.write(this.state);
      return this.status();
    }
    if (message.type === 'sign-out') {
      const account = this.state.accounts.find(a => a.id === message.accountId);
      if (!account) throw new ComposerError('auth');
      const revoked = await revokeAccount(account, {signal, fetchImpl: this.fetchImpl});
      delete account.accessToken; delete account.refreshToken; delete account.idToken; delete account.expiresAt; delete account.scopes;
      delete this.state.models[`openai-chatgpt:${account.id}`];
      this.catalogues.delete(`openai-chatgpt:${account.id}`);
      await this.store.write(this.state);
      return {...this.status(), revoked};
    }
    if (message.type === 'models') return {models: await this.catalogue(message.provider, signal)};
    if (message.type === 'select-model') {
      const models = await this.catalogue(message.provider, signal);
      if (!models.some(m => m.id === message.model)) throw new ComposerError('model');
      this.state.models[this.catalogueKey(message.provider)] = message.model;
      await this.store.write(this.state);
      return this.status();
    }
    if (message.type === 'suggest') {
      const request = composerRequest(message.request);
      // This scope is supplied by the trusted extension background, never by
      // the Twitch content payload. Standalone helper callers remain isolated.
      if (message.contextKey !== undefined && (typeof message.contextKey !== 'string' ||
        !/^[a-zA-Z0-9:_-]{1,200}$/.test(message.contextKey))) throw new ComposerError('request');
      this.contextKey = message.contextKey ?? 'standalone';
      if (request.provider === 'claude-code') {
        if (!this.claude) throw new ComposerError('claude-missing');
        const credential = createHash('sha256').update(String(message.claudeToken)).digest('hex');
        const identity = JSON.stringify([this.contextKey, request.provider, credential, request.sourceLanguage, request.targetLanguage]);
        return this.session.run(identity, promptFor(request).input,
          ({signal: sessionSignal}) => this.claude.suggest(request, {token: message.claudeToken, signal: sessionSignal}),
          {signal, remember: !request.assessment, clear: () => this.claude.clear?.(), close: () => this.claude.close?.()});
      }
      const token = await this.token(request.provider, signal);
      let model = 'claude-haiku-5-5';
      if (request.provider !== 'anthropic') {
        const key = this.catalogueKey(request.provider);
        model = this.state.models[key];
        const models = this.catalogues.get(key) ?? await this.catalogue(request.provider, signal);
        if (!models.some(m => m.id === model)) throw new ComposerError('model');
      }
      const account = request.provider === 'openai-chatgpt' ? this.state.activeAccount
        : createHash('sha256').update(token).digest('hex');
      const identity = JSON.stringify([this.contextKey, request.provider, account, model, request.sourceLanguage, request.targetLanguage]);
      return this.session.run(identity, promptFor(request).input,
        options => suggest(request, {token, model, fetchImpl: this.fetchImpl, ...options}),
        {signal, remember: !request.assessment});
    }
    throw new ComposerError('request');
  }
}
