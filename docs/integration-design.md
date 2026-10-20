# Streamir Chrome viewer integration

## Product requirements

The extension is the next iteration of Lexxyicon. It runs on desktop Chrome while
the viewer watches an existing Twitch channel, initially `hexxyi`.

1. Activating the extension identifies the channel in the current Twitch tab and
   asks the Streamir server which translated feeds are available.
2. The viewer selects an advertised language. Never list a language without server
   evidence that its feed exists.
3. The extension plays the selected server-generated dub in synchronization with
   the original stream and ducks the original while the dub plays.
4. Incoming chat is translated into the selected language by Chrome's built-in
   Translator. Include existing visible messages and new arrivals, retain usernames,
   mentions, emotes and links, and keep native chat usable if translation fails.
5. Retain the viewer's draft reply helper. The viewer reviews the result and submits
   it through Twitch's native chat input; the extension never sends a message.
6. Receive captions with the audio feed. A separate display toggle controls the
   overlay without stopping audio, unsubscribing, or changing synchronization.
7. Speech recognition, speech translation, and voice generation do not run on the
   viewer's machine. The viewer performs audio fingerprinting solely for sync;
   sampled tab audio is never uploaded.

The draft helper offers Anthropic Haiku 5.5 API, OpenAI API, and OpenAI ChatGPT plan
OAuth for the local development app. For the user's personal test, settings detect
an existing local Claude Code executable and show token generation only when found.
The local helper drives `setup-token` in a private terminal session. Settings show
Claude's authorization link and accept its returned code; Claude Code performs the
exchange locally. The extension automatically stores the resulting token in
trusted local storage and supplies it to the installed executable for each draft
request. There is no hosted Claude runtime.
Choices, back-translations, refinement, undo, and manual Twitch
submission are preserved. Its native connection handles credentials and direct
provider requests; it does not run recognition or voice synthesis.

The composer now reuses a slim Haiku 5.5 / low-effort Claude Code process. After
two minutes idle it sends `/clear` and verifies the reset; an unsupported or
unconfirmed reset discards the process. API providers reuse bounded in-memory
composer turns with stable prompts and cache settings. All routes reset at
12 turns / 32,768 context characters or on scope/account changes. Incoming Twitch
chat is not included. See [session and caching details](composer-auth.md).

An optional **How might this land?** check assesses one already translated version
for natural phrasing, tone and cultural references. Its Settings checkbox is off
by default because each explicitly requested check uses credits or subscription
allowance. It runs separately after translations appear, with cached reopening
and an optional handoff into the existing refinement editor. It does not alter
the viewer-feed contract or send chat messages.

The loadable build currently contains this composer. The incoming Chrome chat
translator and server audio player still need integration.

## Authority and reuse

The server owns the wire and synchronization contract:

- `../../streamir-server/docs/superpowers/specs/2026-10-19-streamir-server-design.md`,
  C4, C8 and section 10.
- `../../streamir-server/server/streamir_server/contracts.py`.
- `../../streamir-server/server/streamir_server/app.py` and `feed.py`.

On 20 October 2026, the viewer session accepted the server-owned
[viewer feed v1 contract](../../streamir-server/docs/contracts/viewer-feed-v1.md)
after reviewing the Python contracts and product spec section 10. Its independent
caption and speech timing, identity/reset, per-type deduplication, late-join
fallback and no-replay rules are agreed requirements. The parser, transport reset,
decode/session lifecycle and independent scheduling core now implement those
rules with deterministic tests. Browser integration and live sync have not passed.

Server-thread ingestion handoff, 20 October 2026 (reported work in progress,
not independently verified by this viewer): the new path pulls Twitch `audio_only`,
applies decision cleanup/Silero VAD and a per-channel enrolled ERes2Net speaker
gate, then sends raw Russian GigaAM ASR into the shared caption/voice pipeline.
The browser feed contract and viewer scheduling rules remain unchanged.

Pulled media time uses the decoded 16 kHz sample clock. `clock_epoch` anchors the
first locally decoded frame; it must not be interpreted as broadcaster capture
time or used to infer the viewer offset. Reconnection, a PTS discontinuity, or
OBS takeover emits a fresh `hello`, which resets the viewer even when its epoch
value repeats. A trusted validated OBS `hello` takes priority; its disconnect
starts a new pull.

This ingress milestone supplies no fabricated fingerprints. Pulled-source viewer
synchronization remains **unqualified** until compatible fingerprints from
continuous original audio, extractor/matcher parity, and a live synchronization
trial are available. Audio must continue to wait for a real fingerprint lock.
Captured utterance spans include bounded raw context of 0.6 seconds before VAD
and 0.15 seconds after; treat these as utterance spans, not word timestamps.

The parser accepts all four message types and rejects missing/extra fields,
including nested audio fields. Its defensive limits are consumer policy, not
enforced server guarantees: 2 × 1024 × 1024 UTF-16
code units per JSON frame (`raw.length`, despite the `MAX_MESSAGE_BYTES` name),
10,000 code units of caption text, 20,000 landmarks per batch, and nonnegative
safe-integer sequence IDs through 2^53 − 1. Producer/server bounds and shared
boundary fixtures still need reconciliation; these tests do not establish complete
validator parity for every possible server input.

Reuse the behavior in Lexxyicon's chat DOM handling, caption overlay, draft composer,
and Twitch draft insertion. Adapt its settings and text translation to the selected
feed language. Its existing Russian-only filter and last-five-message startup
snapshot do not fully meet the new all-chat requirement.

Do not import Lexxyicon's local speech pipeline, model preparation, voice engine
selection, or speech helper. Its `VoicePlayback` class is coupled to local synthesis;
reuse its Web Audio playback and ducking behavior while accepting complete server
Ogg/Opus sentences.

This checkout is separate from `lexxyicon`; sibling sources have only been read.

## Implemented server contract

Connect anonymously to `wss://server.streamir.app/feed/<channel>`. The client sends
no caption text, chat, raw audio, or fingerprint messages.

```json
{"type":"hello","v":"feed_v1","channel":"hexxyi","clock_epoch":"2026-10-20T12:00:00.000Z","lang":"en"}
{"type":"caption","v":"feed_v1","seq":1,"t_start":1.0,"t_end":2.0,"text_en":"Hello"}
{"type":"say","v":"feed_v1","seq":1,"t_start":1.0,"t_end":2.0,"text_en":"Hello","audio":{"codec":"ogg/opus","data":"<base64 audio>"}}
{"type":"fp","v":"utt_v1","hashes":[[123456,1.0]]}
```

The actual server includes `type`, and fingerprints retain `v: "utt_v1"` when
forwarded. Unknown versions, extra fields, malformed audio, and mismatched channels
must fail. Captions arrive independently before optional speech. Different
utterances may interleave; deduplicate caption and say separately. A say without
an earlier caption supplies fallback text subject to the same caption timing.
Every `hello`, including a reconnect with an unchanged epoch, clears old scheduled
audio and synchronization state. Sequence deduplication is scoped to that session.

`src/feed/session.js` connects `FeedClient` to the scheduler. It considers orphan
say captions before decode, suppresses duplicate speech while decoding, bounds
pending decode work to 32 events and concurrent decodes to two, and ignores old
decode results after hello, disconnect or channel change. Old uninterruptible
decodes remain counted against concurrency until they settle. Speech overflow or
decode failure cannot discard an otherwise eligible caption.

Every reset notifies the fingerprint matcher. Its asynchronous results must pass
the captured generation to `session.setLock()`. Pause and explicit seek/ad/player
invalidation advance the matcher generation without deleting still-unstarted
utterances. A resumed player requires a fresh lock.

`feed_v1` currently hardcodes English and `text_en`. Its greeting is sufficient to
discover the one implemented language without inventing an HTTP endpoint. A cached
hello does not prove a live producer; there is no live/offline event. This is
not a multi-language catalogue: that requires an agreed server extension specifying
available languages, their feed addresses, live/offline status, and caption fields.

## Synchronization

C8 requires 8 kHz mono audio, a 1024-point Hann STFT with a 256-sample hop, spectral
peak selection and landmark hashing shared with the server-owned Rust helper.
Match producer and consumer hashes over a 30-second window, with 32 ms offset bins.
Lock requires confidence at least 0.2 for five seconds. Unlock requires confidence
below 0.05 for three seconds. Pause, seek, channel changes, and player replacement
must invalidate playback immediately.

For consumer landmarks stamped in `AudioContext.currentTime` units:

```text
offset = consumer_audio_time - producer_sample_time
scheduled_audio_time = sentence.t_start + offset
```

The server's wall-clock formula is equivalent after conversion to the consumer
clock. Do not add `clock_epoch` a second time to an offset already expressed in
audio-clock units.

Decode server audio with `decodeAudioData`; schedule future sentences at their
matched time. Play a late sentence immediately unless its scheduled start is more
than five seconds in the past, rechecking after decoding and queueing. Use decoded
duration for completion and never overlap dubs. While unlocked, hold bounded
queues and clear the overlay. On relock, reconsider only unstarted speech; an
interrupted dub must not replay.

Use a separate audio branch for fingerprinting so dubbed audio is not fingerprinted
again. Preserve original stereo playback. Duck the original by 8 dB with 50 ms
attack and 300 ms release during actual dubbed speech. Independently display each
caption only over `[t_start + offset, t_end + offset)`: hold early text, show partly
elapsed text for the remainder, and discard expired text. Speech arrival, failure
or completion must never delay, clear, extend or redisplay a caption. Toggling
captions on shows only the currently eligible source span.

`FeedScheduler` maintains separate caption and decoded-speech queues (128 each
by default) and deduplication sets per hello generation. Caption selection uses
the most recent eligible start when source spans overlap. Queue pressure drops
speech independently; unlocked caption overflow keeps the most recent spans.
Started speech is discarded on interruption; scheduled-but-unstarted speech can
be reconsidered against the next lock. Old playback completion callbacks are inert.

The browser playback owner must call `session.tick()` against the audio clock,
wire `showCaption`/`clearCaption` to its overlay, and implement
`play(entry, at, ended)` with a cancellable Web Audio source. That callback must
use decoded-buffer completion and actual-playback ducking; `restoreGain` must
cancel duck automation on invalidation. These browser adapters, event wiring,
offscreen lifecycle and perceptual timing checks are still integration work.

Tests exercise all five timing examples in the canonical contract through their
boundary conditions, malformed/extra fields, limits, out-of-order speech,
caption-only and failed-decode paths, visibility toggles, repeated hello,
disconnect, channel changes, decode pressure, and late matcher/completion results.
These are synthetic clock and transport tests, not measurements of live Twitch.

The exact fingerprint hash packing, resampler, window normalization, peak ties, and
pair-selection order must come from the server-owned reference implementation and
fixture. The prose contract alone does not fix these choices. No compatible
fingerprint extractor has been claimed or substituted.

## Browser flow

The popup should expose the current channel, discovered language selector, activation
control, dub volume, captions toggle, chat status, and draft-helper access. Remember
preferences, but activate capture only after the viewer's explicit action.

Keep the audio session outside the popup so closing it does not stop playback.
Use an offscreen document and the existing tab-capture approach if the browser
integration verifies this isolates original tab audio from extension playback.
Player pause, seek, advertisement state and navigation come from the content script.

Prepare missing chat language packs through an explicit setup click when Chrome
requires activation. Show progress and keep original chat visible. Incoming chat
must never be sent to the Streamir speech service.

Chrome references consulted on 20 October 2026:

- [Translator API](https://developer.chrome.com/docs/ai/translator-api)
- [Audio recording and screen capture](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture)
- [Offscreen documents](https://developer.chrome.com/docs/extensions/reference/api/offscreen)

## Outstanding dependencies and acceptance

- Provision `hexxyi` on the configured server and connect an actual producer.
  Its public feed returned `404 no such channel` during this session.
- Obtain `helper/src/fingerprint.rs` and the pinned WAV/hash fixture from the server
  work. The JavaScript extractor must reproduce those hashes exactly.
- Qualify the new pulled Twitch source separately with continuous original-audio
  fingerprints, matching extractor/matcher behavior and a live trial. Its local
  first-frame epoch and successful ingress do not establish viewer synchronization.
- Agree the multi-language discovery extension with the server. Until then,
  advertise only the English language actually announced by `feed_v1`.
- Resolve Claude subscription authentication and verify the implemented draft helper
  with a connected provider and real Twitch chat. Incoming chat continues
  to use Chrome's built-in translation in the product requirements.
- Build and exercise the popup, offscreen player, chat integration, and caption
  toggle in Chrome.
- Verify source and 480p playback, an advertisement, pause/resume, seek, epoch
  reset, reconnect, channel navigation, and player catch-up. Measure scheduled
  playback error against the server's 100 ms gate and worklet CPU against its 1%
  gate; synthetic scheduler tests do not satisfy either live measurement.
- Confirm chat translation and draft insertion preserve emotes, links, usernames,
  existing drafts, native submission, and chat scrolling.
