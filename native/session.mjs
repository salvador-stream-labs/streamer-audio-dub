import {randomUUID} from 'node:crypto';
import {ComposerError} from '../src/composer/contract.js';

export const SESSION_IDLE_MS = 120000;
export const SESSION_MAX_TURNS = 12;
export const SESSION_MAX_CHARACTERS = 32768;

// One bounded, memory-only conversation per native host. A different tab,
// document, channel, provider, account, model or language gets a fresh scope.
export class ComposerSession {
  constructor({idleMs = SESSION_IDLE_MS, maxTurns = SESSION_MAX_TURNS,
    maxCharacters = SESSION_MAX_CHARACTERS, now = Date.now} = {}) {
    Object.assign(this, {idleMs, maxTurns, maxCharacters, now});
    this.history = []; this.turns = 0; this.characters = 0;
    this.generation = 0; this.settling = Promise.resolve();
  }
  erase() { this.history = []; this.turns = 0; this.characters = 0; }
  clear() {
    clearTimeout(this.timer);
    this.erase();
    const clear = this.clearProvider, close = this.closeProvider;
    // Clearing is local control work, never a generated summary or model call.
    this.settling = this.settling.then(() => clear?.());
    // Retain a handled promise; the next request also awaits the cleanup.
    this.settling = this.settling.catch(() => close?.());
    return this.settling;
  }
  async reset() {
    clearTimeout(this.timer); this.generation++;
    this.active?.abort(); this.erase(); this.key = null; this.cacheKey = null;
    const close = this.closeProvider;
    this.clearProvider = null; this.closeProvider = null;
    this.settling = this.settling.catch(() => {}).then(() => close?.());
    await this.settling;
  }
  async run(key, input, operation, {signal, clear, close, remember = true} = {}) {
    if (this.busy) throw new ComposerError('busy');
    this.busy = true;
    try {
      let generation = this.generation;
      if (key !== this.key) {
        const reset = this.reset();
        generation = this.generation;
        await reset;
        if (generation !== this.generation) throw new ComposerError('cancelled');
        this.key = key; this.cacheKey = `streamir-${randomUUID()}`;
      }
      this.clearProvider = clear; this.closeProvider = close;
      clearTimeout(this.timer);
      if (this.turns && (this.now() - this.lastActivity >= this.idleMs ||
        this.turns >= this.maxTurns || this.characters >= this.maxCharacters)) await this.clear();
      await this.settling;
      signal?.throwIfAborted();
      if (generation !== this.generation) throw new ComposerError('cancelled');
      const controller = this.active = new AbortController();
      const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
      const started = performance.now();
      const result = await operation({history: this.history, cacheKey: this.cacheKey, signal: combined});
      combined.throwIfAborted();
      if (generation !== this.generation) throw new ComposerError('cancelled');
      const output = JSON.stringify(result.assessment ? {assessment: result.assessment} : {variants: result.variants});
      if (remember) this.history.push({role: 'user', content: input}, {role: 'assistant', content: output});
      this.characters += input.length + output.length;
      this.turns++; this.lastActivity = this.now();
      const value = {...result, timing: {providerMs: Math.round(performance.now() - started), sessionTurn: this.turns}};
      this.timer = setTimeout(() => { void this.clear().catch(() => {}); }, this.idleMs);
      this.timer.unref?.();
      return value;
    } catch (error) {
      await this.reset();
      throw error;
    } finally { this.active = null; this.busy = false; }
  }
}
