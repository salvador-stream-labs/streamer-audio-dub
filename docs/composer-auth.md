# Draft composer providers

This feature sends the viewer's draft to their selected provider to propose three
versions and faithful back-translations. Each refinement adds the original draft,
chosen version, and latest feedback. Recent successful composer turns are reused
in a short, memory-only session. Incoming Twitch chat history, stream audio,
Twitch credentials, and other browser content are not included.

## Optional wording assessment

The **Enable “How might this land?” checks** checkbox defaults to false, including
for existing installations. The background worker checks the saved preference
before forwarding an assessment; a content-script flag cannot opt the user in.
Enabling the feature makes no inference request.

Once translations are available, **How might this land?** on one version makes
a separate request through the selected provider and model. It returns an overall
impression, naturalness, tone, cultural-reference considerations and an optional
adjustment, explained in the viewer's source language. It is an estimate from the
wording, not knowledge of this particular audience. The prompt asks for specific
phrase-based observations, qualified uncertainty and no nationality stereotypes
or invented context.

Each check uses API credits or subscription allowance. There are no automatic
checks, retries, alternate-provider fallbacks or three-version fan-outs. Reopening
a completed check uses its in-memory result. **Refine from this advice** fills the
feedback editor; **Update wording** still requires a separate explicit action.
Refining or undoing discards advice for the previous wording. Editing the draft,
switching settings/channel or closing the composer cancels outstanding work and
rejects late output. Cancellation cannot undo usage already incurred.

The versions remain visible and insertable during a check; other inference
actions wait for completion or cancellation. Failed checks preserve the versions.
No check inserts, rewrites or submits a chat message.

Direct API assessments use a separate prompt/schema and only the original draft
and selected text. Their history is neither supplied to the check nor added to
later translation requests; OpenAI uses a distinct assessment cache key. Local
Claude reuses the same slim process and its fixed, combined schema/system prompt,
with an explicit per-turn task flag. Its conversation therefore contains the
assessment until the usual clear/reset; the prompt tells it to assess only the
latest supplied wording and not use old assessments as later editing instructions.
Checks count toward session turn/character bounds and the idle timer.

## Warm composer sessions

`native/session.mjs` owns one conversation per helper, with a two-minute inactivity
timeout measured from the last successful response. The timer clears context even
if another request never arrives. A new request waits for an in-progress clear.
Continuous use also clears before the next request after 12 successful turns or
32,768 characters of draft/result context, whichever is reached first.

The background worker assigns the scope from the tab, document and channel.
Content-provided scope IDs and history are ignored. Switching scopes, provider,
languages, account or model discards the previous session. Closing the composer
page, disabling it, changing credentials, cancelling, a failed response or host
shutdown also discards context and closes the Claude process. Closing an unrelated
tab cannot reset the active tab's session. No conversation is saved in the
credential store.

For Claude Code, the installed process stays open with JSON-lines input/output.
It receives a control-protocol initialization with an empty skill allowlist, then
verbatim JSON draft requests. The helper sends the literal built-in `/clear` after
inactivity or at the size/turn limit, and requires both a `conversation_reset`
event and a successful result before reusing the process. If the installed CLI
does not advertise `/clear`, rejects it, or does not confirm within five seconds,
the process is discarded and the next request starts fresh. No generated summary
or periodic inference is used to keep a session alive.

OpenAI's equivalent is a bounded in-memory conversation over HTTP/SSE Responses,
using Node's normal fetch connection pool, not a Codex subprocess or WebSocket.
Successful user/assistant turns are supplied in `input`; `store: false` remains
set and neither server-side conversations nor HTTP `previous_response_id` are
used. The selected account model is preserved. This does not automatically rank
models by latency or change their reasoning effort.

The system prompt and structured-output schema remain identical for initial
suggestions and refinements. Claude Code handles its own prompt caching. Direct
Anthropic requests enable five-minute ephemeral automatic caching plus a stable
system breakpoint. OpenAI receives a stable opaque `prompt_cache_key` for the
session scope; caching itself is automatic. No padding or paid warm-up requests
are added. Cache eligibility and hits depend on model, prompt length and provider
state; a warm session does not guarantee a hit. Clearing conversation context
does not purge the provider's prompt cache.

Replies include provider-call elapsed milliseconds, session turn number and
reported cache-token counts where available. These are transient diagnostics, not
logs of drafts or credentials. Claude's usage fields are reported by its harness
and may be cumulative within the conversation; API usage is per response.

Official references checked on 20 October 2026:

- [Claude streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Claude `/clear` in streaming sessions](https://code.claude.com/docs/en/agent-sdk/slash-commands#reset-context-with-clear)
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state)
- [ChatGPT plan request limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

## Local Claude personal test

The user authorized a local test that detects an existing Claude Code executable
and offers token generation when it is present. No Claude runtime is hosted on the
Streamir server, and no CLI is installed automatically.

`native/claude.mjs` searches common install directories and the shell PATH captured
by `native/install.mjs`. Candidates must be executable files. Detection runs when
settings open, when the viewer rechecks, before token generation, and before a
new inference process is launched. An already running inference process is reused.

**Connect local Claude Code** starts the detected executable with `setup-token`
in a local PTY (`native/claude-login.mjs`). macOS uses BSD `script` behind a real
pipe; Linux uses util-linux `script`. The executable path is supplied in a quoted
environment argument, never interpolated into shell source. The shell programs
are fixed. No credentials or drafts appear in command arguments.

A headless xterm renderer reads the CLI's actual screen, including ANSI cursor
movement and wrapped lines. Settings display its validated Claude authorization
URL, preserving the CLI-owned client ID, state and PKCE challenge unchanged. The
viewer authorizes in the browser and pastes the returned code into settings.
The helper sends the validated code and then Enter to that same local process;
Claude Code performs the exchange. The background worker saves the returned
token automatically and sends only a saved/not-saved result to settings.
There is no custom OAuth client, hosted exchange or Terminal-app automation.

The settings page owns one long-lived extension port for login. Closing it or
cancelling kills the PTY; a ten-minute native expiry also cleans up abandoned
sessions. Invalid/reused session IDs cannot finish another session. The terminal
buffer and temporary configuration directory are discarded on every completion
path. Only Claude authorization URLs with a paste-code callback are accepted.
The CLI can still require a local callback listener internally, even in this mode.

`src/composer/token-store.js` saves the token in `chrome.storage.local` only after
setting access to `TRUSTED_CONTEXTS`. It is not synced. The background worker sends
only whitelisted preferences to Twitch content scripts; credential management and
credential management is accepted only from the extension's own settings/popup
pages, and the interactive login port is accepted only from settings.
Saving a token confirms storage, not authentication or available allowance. Local
Chrome storage is not an encrypted OS keychain.

A Claude draft request receives the token from the background worker, not from the
content script. The native host passes it to the installed executable solely as
`CLAUDE_CODE_OAUTH_TOKEN`, without API-key fallback or persisted native credentials.
The draft is delivered over stdin. Inference uses `claude-haiku-5-5`, low effort,
structured output, safe mode, disabled tools/hooks/connectors/plugins, an empty
skill allowlist, an isolated temporary config and working directory, and no session
persistence. Unexpected tools, plugins, skills or MCP servers reported at startup
are rejected (the CLI's internal `StructuredOutput` formatter is allowed).
Cancellation terminates the process, and temporary files are removed on session
close. The same output checks and manual Twitch
submission apply to all providers.

The Altus reference at `/Volumes/Catalina - Data/Users/samdavey/cap/altus` uses
a server-side `setup-token` process and Agent SDK. This implementation follows its
PTY → authorization URL → pasted code → token approach on the viewer's machine.
Altus was inspected read-only; no Altus credentials or services were used. The
current draft runner invokes local Claude Code directly; it does not use Agent SDK.

Native messaging requires the helper's one-time registration and Chrome's
“Communicate with cooperating native applications” permission. Hosting only the
exchange would not remove that permission while draft inference remains local.

This is a personal test feature, not a claim of approval to offer Claude subscription
access in a distributed product. The SDK's developer guidance requires prior
approval for third-party products offering claude.ai login or subscription limits.

Official references checked on 20 October 2026:

- [Generate a long-lived Claude Code token](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
- [Agent SDK installation and product authentication guidance](https://code.claude.com/docs/en/agent-sdk/quickstart)
- [Chrome extension storage and access levels](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome permission warnings](https://developer.chrome.com/docs/extensions/reference/permissions-list#nativeMessaging)

## Anthropic

Uses `POST https://api.anthropic.com/v1/messages`, API-key authentication, model
`claude-haiku-5-5`, low effort, and `output_config.format` for structured output.
Sampling parameters are omitted. Generated output is validated locally before
being offered for insertion.

This is the implemented direct API option.
Anthropic's general developer guidance recommends API authentication for products.

Official references checked on 20 October 2026:

- [Haiku 5.5 model and API ID](https://platform.claude.com/docs/en/models/haiku-5-5/overview)
- [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Third-party authentication guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account)

## OpenAI

API-key mode and ChatGPT plan mode use the public Responses API. The model selector
uses the connected account's model list. A listed model does not prove that every
request will succeed; permission, capacity, usage, and feature errors remain visible.

ChatGPT OAuth is implemented in the local helper, with:

- A persistent opaque host UUID and per-account issued client IDs.
- Initial `dynamic_agent_client` registration and returning-account reauthorization.
- A loopback callback on `127.0.0.1`, fresh state, nonce, and PKCE.
- RS256 ID-token verification against OpenAI's JWKS, including issuer, audience,
  expiration, nonce and returning-account identity.
- Explicit ChatGPT plan permission checks.
- Protected local credential files, atomic writes, rotating refresh tokens, and
  one native-host owner per credential directory to serialize refresh.
- Account switching and sign-out with attempted renewable-session revocation.
- Inference with `store: false`, `stream: true`, complete-event validation, and
  no unsupported `max_output_tokens` or sampling fields for subscription requests.

This route is for the locally hosted development app. A paid or remotely hosted
version needs a separate commercial arrangement with OpenAI. No private ChatGPT
backend endpoints, existing browser cookies, Codex credential files, or borrowed
client identities are used.

Official references:

- [Local/open-source ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts, storage and refresh](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Commercial client registration](https://developers.openai.com/siwc/request-client-id)

## Verification limits

The tests use fixture credentials and mocked provider responses, including signed
test ID tokens. They exercise a simulated callback transport because this sandbox
cannot open a loopback listener. The native helper and its framed Chrome protocol
were run as actual processes in a temporary installation.

Real account sign-in, a real provider request, browser interaction, and translation
quality must be checked outside this sandbox. The browser test script exists but
Chromium launch was blocked by macOS sandbox permissions during this session.

Local Claude tests use fixture tokens and actual PTY/CLI fixture processes. They
cover terminal rendering, code exchange, session ownership, expiry/cancellation,
storage isolation and cleanup. The installed Claude executable was detected and
started with isolated config. Real setup stopped at its callback-server startup
error in this sandbox; no account authorization or subscription inference was
completed. macOS PTY behavior was exercised; Linux arguments have not been run
on a Linux host.

Warm-session tests run real fixture subprocesses through the JSON-lines transport:
reuse across suggestions/refinement, confirmed idle clear, unsupported/unconfirmed
clear fallback, token rotation, cancellation, unexpected plugins, output overflow
and cleanup. Mock API tests cover stable cache keys, context bounds and isolation.
The installed Claude Code 2.1.304 control-only probe, using a fake token and no
draft request, timed out before initialization in this sandbox. Authenticated
multi-turn inference, real cache hit rates and live latency remain unverified.

Assessment tests cover the saved opt-in boundary, settings persistence, complete
and malformed provider responses, all API routes, same-process local Claude reuse,
credit-free reopening, refinement invalidation, cancellation and stale results.
Panel state transitions run in a DOM fixture; they do not establish visual layout
or the quality of real cultural judgments.
