import {createServer} from 'node:http';
import {randomBytes, createHash, createPublicKey, verify, timingSafeEqual} from 'node:crypto';
import {ComposerError} from '../src/composer/contract.js';
import {readJSON} from './providers.mjs';

const ISSUER = 'https://auth.openai.com';
const TOKEN_ENDPOINT = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function authorizationURL({clientId, hostId, state, nonce, verifier, redirectURI, idToken, email}) {
  const url = new URL(`${ISSUER}/api/accounts/authorize`);
  const initial = !clientId;
  const values = {
    client_id: clientId || 'dynamic_agent_client', ext_agent_host_id: hostId, response_type: 'code',
    redirect_uri: redirectURI, scope: SCOPES, resource: RESOURCE, state, nonce,
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    ...(initial ? {agent_name_hint: 'Streamir Chat Composer'} : {}),
    ...(!initial && idToken ? {id_token_hint: idToken} : {}),
    ...(!initial && email ? {login_hint: email} : {}),
  };
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  return url.href;
}

export function callbackCode(url, {state, clientId}) {
  if (!equal(url.searchParams.get('state'), state)) throw new ComposerError('auth');
  if (url.searchParams.has('error')) throw new ComposerError('denied');
  const issued = url.searchParams.get('client_id') || clientId;
  if (!issued || issued === 'dynamic_agent_client' || !/^[a-zA-Z0-9_.-]{1,200}$/.test(issued) ||
      (clientId && issued !== clientId)) throw new ComposerError('auth');
  const code = url.searchParams.get('code');
  if (!code || code.length > 4096) throw new ComposerError('auth');
  return {code, clientId: issued};
}

export function validateIDToken(token, jwks, {clientId, nonce, subject, now = Date.now() / 1000}) {
  try {
    if (typeof token !== 'string' || token.length > 32768) throw new Error();
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error();
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (header.alg !== 'RS256' || !header.kid) throw new Error();
    const key = jwks.keys?.find(key => key.kid === header.kid && key.kty === 'RSA' &&
      (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'));
    if (!key || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({key, format: 'jwk'}), Buffer.from(parts[2], 'base64url'))) throw new Error();
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== ISSUER || !audience.includes(clientId) ||
      (audience.length > 1 && claims.azp !== clientId) ||
      (claims.azp !== undefined && claims.azp !== clientId) ||
      !Number.isFinite(claims.exp) || claims.exp <= now ||
      !Number.isFinite(claims.iat) || claims.iat > now + 60 ||
      (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 60)) ||
      (nonce !== undefined && !equal(claims.nonce, nonce)) ||
      typeof claims.sub !== 'string' || !claims.sub ||
      (subject && claims.sub !== subject)) throw new Error();
    return {subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : ''};
  } catch { throw new ComposerError('auth'); }
}

function tokenRecord(value) {
  if (value?.token_type?.toLowerCase() !== 'bearer' || typeof value.access_token !== 'string' || !value.access_token ||
    typeof value.refresh_token !== 'string' || !value.refresh_token ||
    !Number.isFinite(value.expires_in) || value.expires_in <= 0 ||
    typeof value.scope !== 'string') throw new ComposerError('auth');
  const scopes = value.scope.split(/\s+/);
  if (!scopes.includes('chatgpt.tokens.use.direct') || !scopes.includes('resource.invoke')) throw new ComposerError('consent');
  return {
    accessToken: value.access_token, refreshToken: value.refresh_token,
    idToken: value.id_token, expiresAt: Date.now() + value.expires_in * 1000, scopes,
  };
}

async function postToken(fields, fetchImpl, signal) {
  const response = await fetchImpl(TOKEN_ENDPOINT, {method: 'POST', redirect: 'error', signal,
    headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams(fields)});
  if (!response.ok) { await response.body?.cancel(); throw new ComposerError('auth'); }
  return readJSON(response);
}
async function identity(token, expected, fetchImpl, signal) {
  const jwks = await readJSON(await fetchImpl(`${ISSUER}/.well-known/jwks.json`, {redirect: 'error', signal}));
  return validateIDToken(token, jwks, expected);
}

export async function signIn({state: saved, accountId, onURL, signal, fetchImpl = fetch, createServerImpl = createServer}) {
  const previous = accountId ? saved.accounts.find(a => a.id === accountId) : null;
  if (accountId && !previous) throw new ComposerError('auth');
  const state = random(), nonce = random(), verifier = random();
  const lifetime = AbortSignal.any([AbortSignal.timeout(180000), ...(signal ? [signal] : [])]);
  lifetime.throwIfAborted();
  let server, abort;
  try {
    let accept, rejectCallback;
    const callback = new Promise((resolve, reject) => { accept = resolve; rejectCallback = reject; });
    // A rejected callback promise is observed even if opening the browser fails.
    callback.catch(() => {});
    server = createServerImpl((request, response) => {
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      if (request.method !== 'GET' || request.url.length > 8192) { response.writeHead(400).end('Invalid callback.'); return; }
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname !== '/auth/callback') { response.writeHead(404).end('Not found.'); return; }
      if (!equal(url.searchParams.get('state'), state)) { response.writeHead(400).end('Invalid sign-in state.'); return; }
      try {
        const value = callbackCode(url, {state, clientId: previous?.clientId});
        response.end('Completing sign-in. Return to Streamir to check the connection.');
        accept(value);
      } catch (error) { response.writeHead(400).end('Sign-in was not completed. Return to Streamir.'); rejectCallback(error); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    abort = () => rejectCallback(new ComposerError(signal?.aborted ? 'cancelled' : 'timeout'));
    lifetime.addEventListener('abort', abort, {once: true});
    if (lifetime.aborted) abort();
    const redirectURI = `http://127.0.0.1:${server.address().port}/auth/callback`;
    await onURL(authorizationURL({clientId: previous?.clientId, hostId: saved.hostId, state, nonce,
      verifier, redirectURI, idToken: previous?.idToken, email: previous?.email}));
    const result = await callback;
    const value = await postToken({grant_type: 'authorization_code', client_id: result.clientId,
      code: result.code, code_verifier: verifier, redirect_uri: redirectURI, resource: RESOURCE}, fetchImpl, lifetime);
    const claims = await identity(value.id_token, {clientId: result.clientId, nonce, subject: previous?.subject}, fetchImpl, lifetime);
    const existing = saved.accounts.find(a => a.clientId === result.clientId);
    if (existing && existing.subject !== claims.subject) throw new ComposerError('auth');
    return {
      id: existing?.id || random(), clientId: result.clientId, ...claims, ...tokenRecord(value),
    };
  } catch (error) {
    if (lifetime.aborted) throw new ComposerError(signal?.aborted ? 'cancelled' : 'timeout');
    if (error instanceof ComposerError) throw error;
    throw new ComposerError('network');
  } finally {
    if (abort) lifetime.removeEventListener('abort', abort);
    server?.close(); server?.closeAllConnections();
  }
}

export async function freshAccount(account, {fetchImpl = fetch, signal} = {}) {
  if (!account?.refreshToken || !account.accessToken) throw new ComposerError('auth');
  if (account.expiresAt > Date.now() + 60000) return account;
  const value = await postToken({grant_type: 'refresh_token', client_id: account.clientId,
    refresh_token: account.refreshToken, resource: RESOURCE}, fetchImpl, signal);
  if (value.id_token) await identity(value.id_token, {clientId: account.clientId, subject: account.subject}, fetchImpl, signal);
  return {...account, ...tokenRecord(value), idToken: value.id_token || account.idToken};
}

export async function revokeAccount(account, {fetchImpl = fetch, signal} = {}) {
  if (!account.refreshToken) return true;
  try {
    const discovery = await readJSON(await fetchImpl(`${ISSUER}/.well-known/openid-configuration`, {signal, redirect: 'error'}));
    const url = new URL(discovery.revocation_endpoint);
    if (url.origin !== ISSUER) return false;
    const response = await fetchImpl(url.href, {method: 'POST', signal, redirect: 'error',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({token: account.refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId})});
    await response.body?.cancel();
    return response.status === 200;
  } catch { return false; }
}
