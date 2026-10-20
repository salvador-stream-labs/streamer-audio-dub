# Streamir: Audio & Chat Translator for Twitch

Chrome desktop viewer for Streamir's server-generated translated audio and captions.
This is the server-backed successor to Lexxyicon. The initial test channel is `hexxyi`.

Speech translation and voice generation belong to the server. Incoming chat stays
on the viewer's computer and uses Chrome's built-in Translator. The viewer's draft
reply helper is retained as a product requirement.

## Current state

The draft reply composer is a loadable development extension. Server audio playback
and incoming chat translation remain separate, unfinished integration work.

The composer supports:

- Personal testing with an existing local Claude Code executable. Settings detect
  it before showing token generation and the local Claude provider.
- Anthropic's direct Messages API with `claude-haiku-5-5`.
- OpenAI's direct Responses API with an API key.
- OpenAI's documented ChatGPT plan OAuth flow for this locally hosted development
  app, with account selection, PKCE, validated ID tokens, refresh, and sign-out.
- Three translated versions with back-translations, refinement, undo, and insertion
  into Twitch's chat box. The viewer always submits the message.
- Optional **How might this land?** checks of a chosen version's tone, natural
  phrasing and cultural references. Enable the checkbox in Settings; it is off
  by default. Each explicitly requested check uses additional provider credits
  or subscription allowance. Translations appear first; reopening advice is free.
- A warm Haiku 5.5 / low-effort Claude Code process, with `/clear` after two minutes
  idle, and equivalent bounded context reuse for the direct APIs. Sessions also
  reset at 12 turns or 32,768 context characters and on tab/channel/account changes.
  Prompt caching is enabled where supported; no warm-up inference is generated.

API keys and ChatGPT OAuth tokens currently live in owner-only local files under
`~/.config/streamir-composer/<extension-id>/`, managed by the native helper.
The helper calls the providers directly or, when selected for personal testing,
runs the detected local Claude Code executable. It does not run speech models.
It supports macOS and Linux.

The Claude test token is stored in the extension's local storage, restricted to
trusted extension contexts. Twitch content scripts receive only sanitized
preferences. The token is never synced and is passed to the local helper only for
a Claude draft request; the helper does not persist it. No hosted Claude runtime
is involved. See [provider authentication](docs/composer-auth.md).

## Load the composer

Use Node.js 22 or later:

```sh
npm ci
npm run build
```

1. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and
   select this project's `dist/` directory.
2. Open Streamir's **Chat connections & settings**. Under **Set up the local
   helper**, copy the command containing your actual extension ID.
3. Run that command from this project folder:

   ```sh
   node native/install.mjs YOUR_CHROME_EXTENSION_ID
   ```

4. Reload the extension and open its settings. Save an Anthropic/OpenAI API key,
   choose **Continue with ChatGPT**, or use **Local Claude test** below. For OpenAI,
   load the account's models and select one. Configure the draft and chat languages.
5. Reload `https://www.twitch.tv/hexxyi`. Draft a message in the reply helper,
   compare the versions, and choose **Use this version**. Review and send it from
   Twitch's native chat box.

Keep the project folder and Node installation in place because the native host's
launcher references them. Re-run helper registration if either moves.

### Test with your installed Claude Code

1. Open settings and choose **Check for Claude Code**. The helper checks common
   installation locations and the PATH captured during helper registration.
   Re-run the installer and reload the extension if your shell's PATH has changed.
2. When the executable is found, choose **Connect local Claude Code**. The helper
   runs `claude setup-token` in a private terminal session on this computer.
3. Follow **Open Claude authorization**, approve access, then paste Claude's
   authorization code into settings and choose **Complete connection**. Keep the
   settings tab open during authorization. Local Claude Code exchanges the code,
   and the extension saves the resulting token automatically and selects local
   Claude. You do not operate Terminal or copy the final token. Save means stored,
   not inference authentication verified.
4. Request draft versions on Twitch to test Haiku 5.5. **Remove saved Claude token**
   deletes the extension's copy. An expired token must be regenerated.

Token generation is hidden when no executable is found. Detection is repeated
before launch of a new process. No installation or token generation
starts automatically. **Cancel Claude connection**, closing settings, or the
ten-minute expiry terminates the local session and removes its temporary config.
Chrome's native-messaging permission is described as “Communicate with cooperating
native applications”; no Terminal-app automation is used.

The ChatGPT flow uses the documented local-app dynamic registration entry point.
It must not be advertised as approved subscription access for a paid or remotely
hosted release. That distribution needs OpenAI's separate commercial arrangement.
Anthropic API mode uses an API key.
See [provider authentication](docs/composer-auth.md) for source links.

## Audio integration core

- `src/feed/protocol.js` validates `hello`, `caption`, `say` and unchanged `utt_v1`
  fingerprints, rejecting missing/extra fields and enforcing consumer limits.
- `src/feed/client.js` discovers the current English feed from its actual `hello`,
  handles reconnection, and delivers every new `hello` as a synchronization reset.
- `src/feed/session.js` delivers captions before audio decoding, bounds decode
  work, and rejects old decode/matcher results after timeline resets.
- `src/audio/scheduler.js` times captions independently over the original source
  span. Speech has its own five-second freshness limit, rechecked after decode
  and queueing; interrupted speech never restarts.
- `tests/` exercises the agreed contract's timing examples, strict parsing,
  interleaving/deduplication, resets, visibility, failure and overflow paths.

These modules are not yet connected to a browser audio player, matcher or caption
overlay. The canonical agreement is the sibling server's
[viewer feed v1 contract](../streamir-server/docs/contracts/viewer-feed-v1.md).

## Validation

```sh
npm test
npm run build
npm run test:browser
```

On 20 October 2026, the automated suite and extension build passed. Tests
cover the provider request contracts, malformed output, interrupted streams, OAuth
PKCE/state/signature/identity checks, token rotation, credential permissions,
extension message authorization, a staged native-helper install and status exchange,
and the audio feed/scheduling core. Claude tests cover executable detection and
removal, conditional setup controls, trusted extension storage, credential message
boundaries, fixture CLI output, cancellation, and temporary-file cleanup. Login
tests run the real macOS PTY wrapper against a harmless executable fixture, covering
URL/code/token exchange, rejected codes, expiry, session ownership, and ANSI rendering.
Warm composer tests also cover process reuse, confirmed `/clear`, idle/size/turn
limits, tab/account/model isolation, cache parameters, cancellation and cleanup.

The actual local executable was detected at `/Users/samdavey/.local/bin/claude`.
The real CLI was started in an isolated temporary config, but it reported failure
to start its OAuth callback server in this sandbox. A real account exchange remains
unverified. Inference used a fixture subprocess. No real token was generated or
read, and no subscription inference request was made.
The installed Claude Code 2.1.304 also timed out before initialization during a
control-only warm-session probe with a fake token. Persistent inference and cache
hit rates have fixture coverage but still need a real-account smoke test.

The OAuth round trip uses a controlled callback transport and mocked provider
responses. Browser testing was attempted but Chromium could not start under the
session sandbox (`bootstrap_check_in: Permission denied`). Loopback listeners were
also blocked (`listen EPERM`). No real provider credentials or paid inference were
used, and real sign-in, translation quality, and Twitch insertion remain unverified
in the user's browser.

The build dependencies and lockfile entries were reused from the pinned sibling
Lexxyicon installation because npm could not reach the registry. The added runtime
dependency `@xterm/headless` 5.5.0 was downloaded using curl and verified against
the registry integrity and Altus lockfile before extraction.

The requirements, server dependencies, reuse plan, and remaining acceptance checks
are in [the integration design](docs/integration-design.md).

## Verified integration limits

On 20 October 2026:

- The sibling server's serializers produced `hello`, `caption`, `say`, and `fp` messages that
  this client parsed successfully.
- `https://server.streamir.app/healthz` answered `200 ok`.
- `https://server.streamir.app/feed/hexxyi` answered `404 no such channel`.
- The checked-out server contract supports English only and has no language catalogue.
- The server-owned fingerprint reference implementation and pinned fixture required
  by its C8 contract were absent from the sibling checkouts.

The tests do not establish live audio synchronization or browser audio decoding.
The server thread reports a new Twitch audio-only ingestion path in development.
Its decoded-sample clock and local first-frame epoch do not establish the viewer
offset. Pulled-source synchronization remains unqualified until continuous
original-audio fingerprint compatibility and a live trial pass; existing viewer
scheduling and fresh-`hello` reset rules still apply.
The Chrome incoming-chat translator and full audio viewer are not part of this
composer development build.
