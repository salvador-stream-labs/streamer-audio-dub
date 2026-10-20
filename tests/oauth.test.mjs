import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign, createHash} from 'node:crypto';
import {mkdtemp, rm, stat, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {authorizationURL, callbackCode, validateIDToken, signIn, freshAccount} from '../native/oauth.mjs';
import {CredentialStore} from '../native/store.mjs';
import {frame, decoder} from '../native/protocol.mjs';

const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const jwks = {keys: [{...publicKey.export({format: 'jwk'}), kid: 'test-key', use: 'sig', alg: 'RS256'}]};
const claims = extra => ({
  iss: 'https://auth.openai.com', sub: 'viewer', aud: 'oaiapp_test', nonce: 'nonce',
  email: 'viewer@example.com', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...extra,
});
function jwt(value, header = {alg: 'RS256', kid: 'test-key'}) {
  const input = [header, value].map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  return input + '.' + sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
}
test('initial registration uses dynamic client, stable host, PKCE and plan scopes; returning registration reuses its ID', () => {
  const args = {hostId: 'urn:uuid:test', state: 'state', nonce: 'nonce', verifier: 'verifier', redirectURI: 'http://127.0.0.1:1234/auth/callback'};
  const first = new URL(authorizationURL(args));
  assert.equal(first.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(first.searchParams.get('agent_name_hint'), 'Streamir Chat Composer');
  assert.equal(first.searchParams.get('code_challenge'), createHash('sha256').update('verifier').digest('base64url'));
  assert.ok(first.searchParams.get('scope').includes('chatgpt.tokens.use.direct'));
  const again = new URL(authorizationURL({...args, clientId: 'oaiapp_test'}));
  assert.equal(again.searchParams.get('client_id'), 'oaiapp_test');
  assert.equal(again.searchParams.get('ext_agent_host_id'), 'urn:uuid:test');
  assert.equal(again.searchParams.has('agent_name_hint'), false);
});
test('OAuth callback rejects state mismatch, missing issued ID, denied access and account swapping', () => {
  const url = values => new URL('http://127.0.0.1:1234/auth/callback?' + new URLSearchParams(values));
  const valid = {state: 'state', client_id: 'oaiapp_test', code: 'code'};
  assert.deepEqual(callbackCode(url(valid), {state: 'state'}), {code: 'code', clientId: 'oaiapp_test'});
  for (const values of [{...valid, state: 'wrong'}, {...valid, client_id: 'dynamic_agent_client'}, {...valid, error: 'access_denied'}]) {
    assert.throws(() => callbackCode(url(values), {state: 'state'}));
  }
  assert.throws(() => callbackCode(url(valid), {state: 'state', clientId: 'different'}));
});
test('ID tokens require a valid signature, issuer, audience, nonce and non-expired identity', () => {
  const expected = {clientId: 'oaiapp_test', nonce: 'nonce', subject: 'viewer'};
  assert.equal(validateIDToken(jwt(claims()), jwks, expected).subject, 'viewer');
  for (const overrides of [{iss: 'https://evil.test'}, {aud: 'other'}, {nonce: 'other'}, {sub: 'other'},
    {exp: 1}, {exp: 'tomorrow'}, {aud: ['oaiapp_test', 'other'], azp: 'other'}]) {
    assert.throws(() => validateIDToken(jwt(claims(overrides)), jwks, expected));
  }
  assert.throws(() => validateIDToken(jwt(claims(), {alg: 'none', kid: 'test-key'}), jwks, expected));
  const token = jwt(claims()).split('.'); token[1] = Buffer.from(JSON.stringify(claims({sub: 'tampered'}))).toString('base64url');
  assert.throws(() => validateIDToken(token.join('.'), jwks, expected));
});
test('OAuth callback transport exchanges the exact redirect URI and validates returned identity', async () => {
  let authorize, handler, closed = false;
  const account = await signIn({
    state: {hostId: 'urn:uuid:test', accounts: []},
    createServerImpl: callback => {
      handler = callback;
      return {
        once() {},
        listen(port, host, ready) { assert.equal(host, '127.0.0.1'); ready(); },
        address() { return {port: 14551}; },
        close() { closed = true; },
        closeAllConnections() {},
      };
    },
    onURL: async value => {
      authorize = new URL(value);
      const callback = new URL(authorize.searchParams.get('redirect_uri'));
      assert.equal(callback.hostname, '127.0.0.1');
      callback.search = new URLSearchParams({state: authorize.searchParams.get('state'), code: 'test-code', client_id: 'oaiapp_test'}).toString();
      handler({method: 'GET', url: callback.pathname + callback.search}, {
        setHeader() {}, end() {}, writeHead() { assert.fail('Valid callback was rejected'); },
      });
    },
    fetchImpl: async (url, options) => {
      if (url.endsWith('jwks.json')) return Response.json(jwks);
      assert.equal(options.body.get('redirect_uri'), authorize.searchParams.get('redirect_uri'));
      assert.equal(options.body.get('client_id'), 'oaiapp_test');
      assert.equal(options.body.get('resource'), 'https://api.openai.com/v1');
      assert.equal(createHash('sha256').update(options.body.get('code_verifier')).digest('base64url'), authorize.searchParams.get('code_challenge'));
      return Response.json({
        token_type: 'Bearer', access_token: 'access', refresh_token: 'refresh', expires_in: 3600,
        scope: 'openid resource.invoke chatgpt.tokens.use.direct',
        id_token: jwt(claims({nonce: authorize.searchParams.get('nonce')})),
      });
    },
  });
  assert.equal(account.subject, 'viewer');
  assert.equal(account.clientId, 'oaiapp_test');
  assert.equal(account.accessToken, 'access');
  assert.equal(closed, true);
});
test('refresh uses the saved issued client, replaces rotating tokens, and preserves account identity', async () => {
  const original = {clientId: 'oaiapp_test', subject: 'viewer', accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 1, idToken: 'retained'};
  const fresh = await freshAccount(original, {fetchImpl: async (_, options) => {
    assert.equal(options.body.get('client_id'), 'oaiapp_test');
    assert.equal(options.body.get('scope'), null);
    return Response.json({token_type: 'Bearer', access_token: 'new', refresh_token: 'new-refresh', expires_in: 3600,
      scope: 'resource.invoke chatgpt.tokens.use.direct'});
  }});
  assert.equal(fresh.accessToken, 'new'); assert.equal(fresh.refreshToken, 'new-refresh');
  assert.equal(fresh.idToken, 'retained'); assert.equal(original.accessToken, 'old');
});
test('credential writes are private and atomic; a second native host cannot race token refresh', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'streamir-store-'));
  try {
    const store = new CredentialStore(directory), initial = await store.read();
    await store.write(initial);
    assert.equal((await store.read()).hostId, initial.hostId);
    assert.equal((await stat(store.file)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const release = await store.lock();
    await assert.rejects(new CredentialStore(directory).lock(), e => e.code === 'busy');
    await release();
    assert.equal(JSON.parse(await readFile(store.file, 'utf8')).hostId, initial.hostId);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
test('native frames handle fragmented UTF-8 and reject oversized requests', () => {
  const received = [], accept = decoder(value => received.push(value)), bytes = frame({text: 'Привет'});
  for (const byte of bytes) accept(Buffer.from([byte]));
  assert.deepEqual(received, [{text: 'Привет'}]);
  assert.throws(() => decoder(() => {})(Buffer.from([255, 255, 255, 255])));
});
