import {mkdir, open, readFile, rename, chmod, unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ComposerError} from '../src/composer/contract.js';

export class CredentialStore {
  constructor(directory) { this.directory = directory; this.file = path.join(directory, 'credentials.json'); }
  async read() {
    try { return JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new ComposerError('auth');
      return {hostId: `urn:uuid:${randomUUID()}`, accounts: [], activeAccount: null, apiKeys: {}, models: {}};
    }
  }
  async write(value) {
    await mkdir(this.directory, {recursive: true, mode: 0o700});
    await chmod(this.directory, 0o700);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value)); await file.sync(); await file.close();
      await rename(temporary, this.file);
    } catch (error) {
      await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error;
    }
  }
  // The native host owns this lock for its lifetime: only one process can rotate
  // tokens, including when Chrome opens the extension in multiple profiles.
  async lock() {
    await mkdir(this.directory, {recursive: true, mode: 0o700});
    const lockfile = path.join(this.directory, 'host.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(lockfile, 'wx', 0o600);
        await handle.writeFile(String(process.pid)); await handle.close();
        return () => unlink(lockfile).catch(() => {});
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const pid = Number(await readFile(lockfile, 'utf8').catch(() => ''));
        if (!Number.isInteger(pid) || pid < 1) throw new ComposerError('busy');
        try { process.kill(pid, 0); throw new ComposerError('busy'); }
        catch (error) { if (error.code !== 'ESRCH') throw new ComposerError('busy'); }
        await unlink(lockfile).catch(() => {});
      }
    }
    throw new ComposerError('busy');
  }
}
