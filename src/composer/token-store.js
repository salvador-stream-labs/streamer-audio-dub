import {claudeToken} from './contract.js';

export const TOKEN_KEY = 'streamirClaudeToken';
export class ClaudeTokenStore {
  constructor(localStorage) { this.local = localStorage; }
  async secure() { await this.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}); }
  async get() {
    await this.secure();
    const saved = await this.local.get(TOKEN_KEY);
    return saved[TOKEN_KEY] ? claudeToken(saved[TOKEN_KEY]) : null;
  }
  async has() { return Boolean(await this.get()); }
  async set(token) {
    const value = claudeToken(token);
    await this.secure();
    await this.local.set({[TOKEN_KEY]: value});
  }
  async remove() { await this.secure(); await this.local.remove(TOKEN_KEY); }
}
