import {ComposerError} from './contract.js';

// Keep the CLI's URL intact: the CLI owns PKCE, state and the token exchange.
export function claudeAuthorizeURL(value) {
  try {
    if (typeof value !== 'string' || value.length > 4096) throw new Error();
    const url = new URL(value);
    if (!['https://claude.ai', 'https://platform.claude.com', 'https://console.anthropic.com'].includes(url.origin) ||
        url.pathname !== '/oauth/authorize' || url.username || url.password || url.hash) throw new Error();
    const params = url.searchParams;
    const redirect = params.get('redirect_uri');
    if (!['https://platform.claude.com/oauth/code/callback', 'https://console.anthropic.com/oauth/code/callback'].includes(redirect) ||
        params.get('response_type') !== 'code' || params.get('code_challenge_method') !== 'S256' ||
        !params.get('client_id') || !/^[A-Za-z0-9_-]{43}$/.test(params.get('code_challenge') ?? '') ||
        !/^[A-Za-z0-9_-]{8,512}$/.test(params.get('state') ?? '')) throw new Error();
    return value;
  } catch { throw new ComposerError('claude-login'); }
}
export function claudeAuthorizationCode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~+/=#-]{8,512}$/.test(value.trim())) throw new ComposerError('claude-code');
  return value.trim();
}
