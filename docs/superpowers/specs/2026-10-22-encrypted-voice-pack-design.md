# Encrypted viewer voice pack for local Qwen speech

Date: 2026-10-22. Status: design for review; nothing here is implemented.

## Intent

The Streamir server keeps doing what it does: it listens to the streamer, translates,
publishes captions on `/feed/<channel>`, and renders server-side Piper speech (`say`,
today inline Opus, later possibly files on S3). A viewer who installs the extension and
its local Qwen helper should hear every caption spoken on their own computer in the
streamer's cloned voice, and the page should ignore the server's Piper audio for them.

The streamer's voice must not be distributed as something a viewer can lift and reuse.
Today the only way to run Base mode is a reference WAV plus transcript sitting on the
viewer's disk, configured by hand. Instead, the server issues the voice to each viewer
session as an encrypted pack that only the running helper can open, and the helper
turns it into Qwen's clone conditioning in memory.

The owner's words: "I want the captions to be broadcast to the browser and the chrome
extension takes them and generates the voice with Qwen locally but I don't want to
distribute the voice, I want to send it encrypted somehow to the extension, have the
model understand that and then speak the captions. The translated audio from the server
would be ignored."

## Goals

1. A viewer with the extension, helper and public Qwen Base model installed hears
   captions spoken locally in the streamer's voice, with no voice file on their disk.
2. The streamer's reference recording never leaves the server. What is sent is Qwen's
   clone conditioning (speaker embedding, optionally the reference's codec tokens and
   transcript), encrypted at rest and in transit, decrypted only in the helper's memory.
3. Only a current, server-issued grant opens a pack. Stopping grants or rotating the
   pack stops new sessions from using the voice.
4. The page prefers local speech when the viewer selects it, ignores server speech
   audio for that viewer, and falls back visibly to server speech when the helper is
   missing, disconnected or fails.
5. The existing boundaries hold: the helper stays offline, downloads nothing, runs no
   page-supplied paths or code, and never logs caption text or key material.

## Non-goals

- In-browser inference. Qwen stays in the native Python helper; the "browser" part is
  the extension bridge. WebGPU ports of Qwen3-TTS are not part of this work.
- Audio/video synchronization. The page's clock mapping problem is unchanged; local
  speech plays "as ready" under the page's existing delay/queue rules.
- A new server wire protocol for captions. The feed contracts (`feed_v1`, `v2`, `v3`)
  stay as they are. Local speech consumes `caption` events the page already receives.
- Moving the Piper pipeline to S3. Whatever transport `say` uses, the page simply
  does not decode or fetch it when local speech is selected.
- Studio delivery integration. The pack builder in this increment is an explicit
  owner command; moving pack building into Studio's approval workflow is a follow-up.

## Anti-goals (what would make this a failure even if it works)

- Claiming the voice is "protected" against a determined viewer. See the threat
  model: it is not, and documentation and UI must not say otherwise.
- Writing a decrypted pack, a content key or a reference clip to the viewer's disk,
  even temporarily, even in a cache.
- Letting a page make the helper fetch URLs, open paths, or load arbitrary tensors.
- Silently playing both server speech and local speech, or dropping captions when
  local speech fails.
- Breaking the current CustomVoice mode or the local-reference Base mode used for
  development and smoke tests.

## Threat model

The design protects against:

- Casual extraction: nothing in the viewer's filesystem, browser storage, extension
  storage or page memory contains the voice in usable form.
- Use without a current grant: a pack is useless without a grant signed by the server,
  bound to the helper's ephemeral key, and expired within minutes. In v1 grants are
  anonymous, so "entitled" means only "the channel currently offers local voice";
  a script that imitates the helper can obtain a grant and decrypt the pack. The
  grant is a switch and an audit point, not a secret-keeping mechanism.
- Lapsed entitlement: once the channel's pack is withdrawn or rotated, new helper
  sessions cannot load it. Running sessions keep it until the native connection closes.

The design does not protect against a viewer attaching a debugger to the helper, or
patching the open-source worker to dump what it decrypts. Qwen can only consume
plaintext, and the plaintext exists in that process. Every document and UI string
that describes the feature must say "not stored on your computer", never "cannot be
copied".

Within those limits there is a real difference between pack modes:

- `embedding` packs carry only the speaker embedding (1024 floats for the 0.6B Base,
  2048 for the 1.7B Base). Nothing in them can be decoded back into the streamer's
  recording. Cloning fidelity is lower (Qwen's "x-vector only" mode).
- `icl` packs additionally carry the reference clip's 12 Hz codec tokens and
  transcript. This is the quality the owner has already auditioned (the 21 October
  smoke used this path). Codec tokens decode to a close copy of the reference clip
  with the public codec, so an `icl` pack is a compressed recording while in memory.

## What exists today

- Server (`../streamir-server`): Python 3.11 asyncio, `websockets` only, no web
  framework. `App.process_request` answers plain HTTP for `/healthz`, authenticates
  `/plugin`, and 404s unknown channels; everything else is WebSocket. Channels and their
  producer tokens live in SQLite. Voices are Studio-delivered Piper packs pinned by
  SHA-256 in `var/voices.json`. Public origin `https://server.streamir.app` through a
  cloudflared tunnel. Dependencies change only through `uv add`. No `cryptography`
  dependency today. Patterns in `docs/PATTERNS.md` are normative.
- Website (`../streamir/apps/web`, Laravel on Lambda): the native Twitch page
  `/twitch/<lang>/<handle>` consumes the feed in `resources/js/twitch/feed-client.js`
  and plays speech in `resources/js/twitch/playback.js` (`LiveInterpretation`). It
  already has a speech-source setting: server `say` audio or a browser
  `speechSynthesis` voice. It owns ducking, volume, delay, a three-deep queue and
  10-second lateness discard.
- Extension and helper (this repo): the popup activates one viewer tab; `content.js`
  bridges page `postMessage` to the background, which opens native host
  `app.streamir.qwen`. `native/host.mjs` validates the installed `host.json`, frames
  32 KiB messages, and `native/service.mjs` runs one resident `native/worker.py`
  (MLX on Apple Silicon or PyTorch) with one active generation and three queued
  requests. Base mode loads `referenceAudio` and `referenceText` from the installed
  config at startup. Extension CSP is `connect-src 'self'` with no host permissions;
  the helper sets `HF_HUB_OFFLINE`. The page adapter `page/local-voice.js`
  (`LocalVoice`) wraps the bridge and owns its own `VoicePlayback`.
- Qwen3-TTS APIs: PyTorch `qwen_tts` builds `VoiceClonePromptItem(ref_code (T,Q),
  ref_spk_embedding (D,), x_vector_only_mode, icl_mode, ref_text)` from audio
  via `create_voice_clone_prompt`, and `generate_voice_clone(voice_clone_prompt=...)`
  accepts prebuilt items. mlx-audio 0.5.9 exposes only `generate(ref_audio, ref_text)`
  for synthesis; internally it computes `speech_tokenizer.encode(ref_audio)` (shape
  `[1, 16, T]`) and `extract_speaker_embedding(ref_audio)`, both public methods, and
  caches the ICL tensors. Installed Base models on the owner's Mac: MLX 4-bit 0.6B
  (`tts_model_size: "0b6"`, `enc_dim: 1024`) and MLX 4-bit 1.7B (`"1b7"`, `enc_dim:
  2048`); both have 16 code groups and the 12 Hz tokenizer. Hexxyi's reference clips
  are Russian speech; Qwen Base clones across languages, and the 21 October smoke
  rendered English from such a reference.

## Architecture

Parties: Server (owns channels, packs, keys, grants), Page (viewer UI on the website),
Extension (bridge only), Helper (Node host plus Python worker holding the model).

```text
owner Mac ── pack builder ──▶ pack.enc + pack.key ──▶ server var/voice-packs/
                                                        │
viewer page ──GET grant(helper pubkey, model)──────────▶ server: wrap content key
viewer page ──GET pack.enc (cacheable, CORS)───────────▶ server (or S3 later)
viewer page ──voice_load(grant, pack.enc)──▶ extension ──▶ host ──▶ worker:
                                                     verify signature, expiry, key,
                                                     model, digest; unwrap; decrypt;
                                                     build clone prompt; forget key
viewer page ──speak(caption job)──────────▶ extension ──▶ host ──▶ worker ──▶ PCM
```

Design rules that fall out of the goals:

- The helper stays offline. The page fetches the grant and the ciphertext and hands
  both through the existing bridge. Ciphertext and a wrapped key are harmless in page
  memory: they are useless without the worker's private key.
- The worker is the only place with plaintext. The Node host and the extension
  forward bytes they cannot read. The page never receives anything derived from the
  plaintext except PCM speech.
- Only server-issued packs load. Grants are Ed25519-signed by the server and the
  helper pins the server's public key at install time, so a page cannot feed the
  helper a pack of its own.
- Packs are tied to a model identity. The helper reports its local model identity;
  the server issues the pack built for it; the worker refuses mismatches.

## Voice pack format (`voice_pack_v1`)

The plaintext is one binary blob: a 4-byte little-endian header length, a UTF-8 JSON
header, then tensor bytes in header order. Unknown header fields, missing fields,
wrong dtypes, out-of-range values and sizes over the bounds all fail.

```json
{
  "v": "voice_pack_v1",
  "pack_id": "hexxyi-qwen3-base-1b7-icl-20261022T120000Z",
  "channel": "hexxyi",
  "voice": {"label": "hexxyi", "consent_ref": "<Studio consent or approval reference>"},
  "model": {"family": "qwen3_tts", "tts_model_type": "base", "tts_model_size": "1b7",
            "tokenizer": "12hz", "enc_dim": 2048, "num_code_groups": 16},
  "mode": "icl",
  "reference_language": "ru",
  "ref_text": "<transcript of the reference clip>",
  "tensors": {
    "spk_embedding": {"dtype": "float32", "shape": [2048], "offset": 0, "length": 8192},
    "ref_codes": {"dtype": "int32", "shape": [144, 16], "offset": 8192, "length": 9216}
  },
  "built": "2026-10-22T12:00:00Z",
  "builder": {"backend": "mlx", "package": "mlx-audio 0.5.9",
              "model_sha256": "<sha256 of the model's config.json>"}
}
```

- `mode` is `icl` (embedding, codes and transcript present) or `embedding` (only
  `spk_embedding`; `ref_text` and `ref_codes` absent).
- `spk_embedding` has exactly `model.enc_dim` floats; the worker checks that against
  the local `config.json`, never a constant.
- `ref_codes` is `[T, num_code_groups]` in the PyTorch layout; the MLX path transposes.
  `T` is at most 160 (12 seconds at 12 Hz plus margin). Values are within the codec
  vocabulary.
- `ref_text` is at most 1,000 UTF-16 code units, as for jobs.
- `reference_language` records the language of the reference clip. It is metadata:
  one pack serves every target language the helper supports (English and German
  routes today), the worker gains no per-job language check from it, and the
  server map is keyed by channel and model identity only.
- Plaintext is at most 1 MiB. A future pack carrying adapter weights is a new version.
- `pack_id` matches `[a-z0-9][a-z0-9_.-]{0,99}`.

The model identity is the tuple the worker can read from the local model's
`config.json`: `tts_model_type`, `tts_model_size` (as written there: `0b6`, `1b7`),
`speaker_encoder_config.enc_dim`, `talker_config.num_code_groups`, plus the tokenizer
family. Its compact string form (`qwen3_tts-base-1b7-12hz`) is what the page passes
to the grant endpoint. Whether a speaker embedding computed for one model size is
usable with another is not assumed: packs are built per model identity and never
cross-matched. A pack built under one backend (MLX or PyTorch) may be consumed by
the other for the same model identity; the embedding is float-close across
frameworks and the codec tokens are discrete, so that combination is accepted only
after the listening check in acceptance, and the header records which backend built it.

## Encryption and grants

All cryptography is standard and comes from the `cryptography` package in both Python
environments (server and helper). Node does no cryptography.

**Pack encryption.** Each pack release gets a fresh random 32-byte content key `K`.
The ciphertext file (`voice_pack_enc_v1`) is: 4-byte little-endian public header
length, public header JSON, 12-byte nonce, AES-256-GCM ciphertext with tag. The
public header is `{"v":"voice_pack_enc_v1","pack_id","channel","model":{...},
"cipher":"aes-256-gcm","size":<plaintext length>}` and is the GCM associated data, so
it cannot be swapped. `K` is stored only on the server, beside the ciphertext, mode
0600, and is never sent.

**Server signing key.** One Ed25519 key per server, generated by an explicit server
command and stored under `var/credentials/`, mode 0600. The server publishes its
32-byte public key (base64url) at `GET /voice/public-key` with CORS `*` for
operators and setup pages, and the README carries the production key. The viewer's
`voice-config.json` pins one to four public keys as `voicePublicKeys`, so a
developer's helper can hold the production key and a local server's key at once.
Each grant names the signing key by `key_id`, the first 16 hex characters of the
SHA-256 of the public key, and the worker verifies with that pinned key or fails.
Rotation beyond adding a key to the list is out of scope.

**Helper identity.** Each worker process generates an X25519 keypair at startup and
keeps the private key in memory only. A worker restart (after a reset during
generation, a watchdog kill, or a new native connection) produces a new key, so a
loaded voice does not survive a restart; the page reloads it.

**Grant.** `GET /voice/<channel>/grant?key=<helper public key, base64url>&model=<model
identity string>` on the server returns:

```json
{"v": "voice_grant_v1",
 "grant": {"v": "voice_grant_v1", "channel": "hexxyi", "pack_id": "...",
           "pack_sha256": "<sha256 of the whole ciphertext file>",
           "pack_url": "https://server.streamir.app/voice/hexxyi/pack/<pack_sha256>",
           "model": {"family": "qwen3_tts", "tts_model_type": "base", "tts_model_size": "1b7",
                     "tokenizer": "12hz", "enc_dim": 2048, "num_code_groups": 16},
           "key_id": "<first 16 hex characters of sha256(signing public key)>",
           "helper_public_key": "<base64url>", "server_public_key": "<ephemeral X25519, base64url>",
           "issued": "2026-10-22T12:00:00Z", "expires": "2026-10-22T12:10:00Z",
           "wrap": {"nonce": "<base64url 12 bytes>", "data": "<base64url 48 bytes>"}},
 "signature": "<base64url Ed25519 signature>"}
```

Key wrapping: `shared = X25519(server_ephemeral_private, helper_public)`;
`kek = HKDF-SHA256(ikm=shared, salt=empty, info="streamir voice_grant_v1" ||
helper_public || server_public, length=32)`; `wrap.data = AES-256-GCM(kek,
wrap.nonce, K, associated_data=canonical(grant without "wrap"))`. The signature is
over `canonical(grant)`. Canonical JSON is `sort_keys=True`,
`separators=(",", ":")`, `ensure_ascii=True`, implemented identically on both sides
and covered by a shared fixture. The server's ephemeral X25519 key is discarded after
the response.

A grant expires 10 minutes after issue. The request is a plain GET with query
parameters so that the server's existing `process_request` hook can answer it
without reading a request body and without a CORS preflight. The response carries
`Access-Control-Allow-Origin: *` and `Cache-Control: no-store`. Nothing in a grant is
secret: it is bound to the helper's public key and useless without the matching
private key.

**Pack fetch.** `GET /voice/<channel>/pack/<pack_sha256>` returns the ciphertext bytes
with `Access-Control-Allow-Origin: *` and `Cache-Control: public, max-age=31536000,
immutable`. The URL is content-addressed, so moving packs to S3/CloudFront later only
changes `pack_url` in the grant; the page always fetches the URL the grant names and
requires `https:`. The page refuses bodies over 4 MiB.

**Load and verification.** The page sends `voice_load` through the bridge with the
grant, its signature and the ciphertext. The worker, in this order, checks: strict
grant fields; `key_id` names one of the pinned public keys and the Ed25519 signature
verifies under it; `issued` no more than 60 seconds in the future and `expires` not
passed; `helper_public_key` equals its own;
`model` equals the local model identity; SHA-256 of the ciphertext equals
`pack_sha256`; the public header's channel, pack id and model equal the grant's.
Then it derives `kek`, unwraps `K`, decrypts, parses the plaintext under the bounds
above, builds the clone prompt, and overwrites its copies of `K`, `kek`, the shared
secret and the plaintext buffer (best effort in Python; stated as such). The reply is
`{loaded: true, pack_id, mode}`. Any failure replies the generic error `voice`; the
exception type goes to stderr as today, never the reason text to the page.

A `voice_load` while a voice is already loaded replaces it when the worker is idle
and is refused with `busy` during a generation. `reset` keeps the loaded voice.
Disconnect kills the worker, which is how the voice leaves memory.

**Entitlement and revocation (v1).** Anyone who can watch the channel can obtain a
grant, the same trust as the anonymous caption feed. The server enforces a
per-channel grant rate limit and a request size bound. Revocation is removing the
channel's pack from the server's map (new grants stop at once) or publishing a new
pack with a new `K` (old ciphertext becomes unopenable for new sessions). Gating
grants on a Twitch sign-in is a future policy point at the same endpoint; the
website could front it then.

## Server work (`../streamir-server`)

- Add `cryptography` with `uv add` (this prompts for confirmation in that repo).
- Configuration, read once in `config.py`: `STREAMIR_VOICE_PACKS=var/voice-packs.json`
  mapping channel to a list of `{pack_id, file, key_file, sha256}`; and
  `STREAMIR_VOICE_SIGNING_KEY=var/credentials/voice-signing.key`. At startup the
  server reads every pack file, verifies its SHA-256 against the map and its public
  header against the entry, loads each content key, and refuses to start on any
  mismatch. Ciphertexts stay in memory (they are small). A channel may list one pack
  per model identity.
- Explicit commands in the `Justfile`: generate the signing key and print its public
  half; validate a `voice-packs.json` against the files on disk. Startup downloads and
  computes nothing.
- `process_request` routes: `GET /voice/<channel>/grant` (JSON, no-store, CORS `*`,
  rate limited per channel, 404 for an unknown channel or model, 400 for a bad key or
  identity string), `GET /voice/<channel>/pack/<sha256>` (bytes, immutable, CORS
  `*`, 404 otherwise) and `GET /voice/public-key` (the signing public key and its
  `key_id`, CORS `*`). The grant uses the wall clock through `clock.py`.
- Logs carry channel, pack id, model identity and outcome, never keys, grants or
  pack bytes. Query strings are not logged.
- A new row in `docs/PATTERNS.md` and a short `docs/VIEWER-VOICE.md` describing the
  files, commands, endpoint and the threat model in the same words as this document.
- Tests: grant construction and canonical JSON fixtures shared with the helper;
  startup refusal on digest mismatch; endpoint responses and headers over the
  websockets test server on 127.0.0.1; rate limiting; `just gate` green.

## Extension and helper work (this repo)

**Contract (`src/voice/contract.js`)**, validated at the page, content script,
background and host as today:

- `voice_identity`: no payload. Reply `{voice, public_key, model}` where `voice` is
  the helper's configured voice source (`pack`, `reference` or `preset`), `model` is
  the identity object and its string form, and `public_key` is present only for
  `pack`. Requires a ready worker, so it is queued like `warmup`. A helper in
  `reference` or `preset` mode refuses `voice_load` with `invalid`; the page treats
  anything but `pack` as "this helper is not set up for the streamer's voice" and
  falls back to server speech. The `local` source never speaks in a preset or
  development reference voice while labelled as the streamer.
- `voice_load`: carries `grant`, `signature` and the ciphertext. Because every hop is
  currently bounded at 32 KiB per message and the worker reads 32 KiB lines, the
  ciphertext travels as ordered parts of at most 16 KiB of base64 each under one
  request id, with a declared total of at most 4 MiB. The host reassembles, enforces
  the bound and the order, and forwards one length-prefixed `load_voice` message to
  the worker over a path with an explicit 8 MiB bound reserved for that message. All
  other messages keep the 32 KiB limit. A part that is out of order, over size, for
  an unknown id, or after completion fails the request with `invalid`.
- `status` gains `voice: {state: "none" | "loaded", pack_id}`.
- `speak` in pack mode with no loaded voice replies `no_voice`. New `ERRORS` entries:
  `no_voice` ("Load the streamer voice first.") and `voice` ("The streamer voice could
  not be loaded.").

**Helper configuration (`native/config.mjs`, `native/install.mjs`)**: Base mode gains
`voice: "pack"` with `voicePublicKeys` (one to four base64url 32-byte keys) and no
reference fields; `voice: "reference"` with `referenceAudio` and `referenceText`
remains for development and the smoke test. CustomVoice is unchanged. The installer
validates the keys and still refuses relative paths and remote models. The README's
recommended viewer install becomes the 1.7B Base 4-bit MLX model in pack mode with
the production public key; CustomVoice stays documented as the no-pack alternative.

**Worker (`native/worker.py`)**: in pack mode, Base initialisation loads the model
and generates the X25519 keypair but builds no prompt. `load_voice` performs the
verification sequence above. On PyTorch the prompt is a `VoiceClonePromptItem` built
directly from the pack tensors (`x_vector_only_mode` for `embedding` packs, `icl_mode`
for `icl` packs). On MLX, mlx-audio's public API takes audio only, so the worker
needs a small adapter that injects the pack's speaker embedding and codec tokens
where `extract_speaker_embedding` and `speech_tokenizer.encode` would have produced
them, without any reference waveform. The adapter targets the pinned mlx-audio
version in `requirements-mlx.txt` and is covered by a parity test: for a fixture
reference, the prefill tensors through the adapter equal those from the audio path.
Steering and all generation bounds are unchanged.

**Page adapter (`page/local-voice.js`)**: add `identity()`, `loadVoice({grant,
signature, pack})` and a generate-only mode (`playback: false`), in which `speak()`
resolves with the PCM samples and metadata and nothing is scheduled by the adapter.
The adapter reloads the voice transparently when a `speak` returns `no_voice` after a
worker restart, through a page-supplied `obtainVoice(identity)` callback that fetches
the grant and the ciphertext; it reports `voice` state changes through `onState`.

**Pack builder (`native/pack.mjs` plus `native/pack.py`)**: an explicit owner command
run with the helper's own `voice-config.json`, so it uses whichever backend and Base
model the owner has installed (MLX on the owner's Mac today; CPU PyTorch also works,
since only the tokenizer and speaker encoder run). Input: a 3–12 second mono PCM16
WAV, its transcript and language, `--mode icl|embedding`, channel, label, consent
reference and output directory. On PyTorch it uses `create_voice_clone_prompt`; on
MLX it uses the model's public `extract_speaker_embedding` and
`speech_tokenizer.encode`. It builds the plaintext in memory, encrypts it, and
writes `<pack_id>.enc`, `<pack_id>.key` (0600) and `<pack_id>.json` (the public
header plus the ciphertext SHA-256, ready to paste into the server map). The
plaintext is never written. `inspect FILE` prints a public header. The smoke tool
gains a `--pack` development path that fabricates a local grant with a throwaway
signing key, so a pack can be rendered to WAV through the real worker without a
server.

**Documentation**: README install steps for pack mode, `docs/local-voice.md` for the
new messages, errors, adapter options and the threat model wording, and the
`manifest.json` description if it mentions a local reference voice.

## Page work (`../streamir/apps/web`)

- Add a third speech source, `local`, to the viewer settings beside server speech
  and browser speech, labelled as the streamer's voice generated on this computer,
  on every route language. When selected and the extension is not connected, or the
  helper reports a voice source other than `pack`, the settings panel shows a short
  install link and the viewer keeps hearing server speech until it is. The viewer
  page currently forces `voice = 'streamer'` for `hexxyi/en` on every load; a saved
  `local` choice must survive that.
- Copy the built `dist/viewer-local-voice.js` into the website's assets, as
  `docs/local-voice.md` already instructs. `LiveInterpretation` keeps being the only
  playback path: in `local` mode it calls `LocalVoice.start()` from the viewer's enable
  gesture, obtains the identity, fetches `GET /voice/<channel>/grant` and the pack
  from the server origin it already uses, calls `loadVoice`, then turns each
  `caption` event into a `speak` job in generate-only mode and enqueues the returned
  PCM as an `AudioBuffer` exactly where a decoded `say` buffer goes today. Ducking,
  volume, delay, the three-deep queue and the 10-second lateness discard apply
  unchanged. The `session` is `<channel>:<feed hello generation>` and the
  `utterance_id` is the caption `seq`; every hello, reconnect and channel change
  calls `reset()`.
- In `local` mode the page does not decode `say` audio and, once `say` becomes a URL,
  does not fetch it. A `say` arriving for a sequence with no caption (late join) is
  treated as a caption and spoken locally.
- Any local failure (`no_voice` after a reload attempt, `voice`, `setup`, disconnect)
  shows the existing warning line and falls back to server speech for subsequent
  sentences without clearing captions. The viewer's choice stays `local` so the next
  page load tries again.

## Operational notes

- First local speech after a cold start waits for model load (tens of seconds on an
  M-series Mac for the 1.7B 4-bit model); the page's loading state already covers this.
- A grant is requested once per worker process, not per sentence. A worker restart
  needs one more grant.
- The server map can hold packs for several model sizes; the viewer installs one
  Base model. The README continues to recommend the 1.7B Base 4-bit MLX model on
  Apple Silicon, which is what the 21 October smoke used.
- Logs on every side keep the existing rule: no caption text, and now no keys,
  grants or pack bytes.

## Acceptance

1. Unit (this repo): pack format round trip and every bound; grant verification
   rejects bad signature, expired or future grant, wrong helper key, wrong model,
   wrong ciphertext digest, tampered public header, oversize parts and unknown
   fields; chunk reassembly bounds; adapter generate-only mode and transparent
   reload; worker leaves no files behind in pack mode.
2. Parity, within one framework: on PyTorch, a pack built from a reference yields
   the same prompt tensors as `create_voice_clone_prompt` on that reference; on
   MLX, the adapter's prefill equals the audio path's for the same fixture. No
   cross-framework equality is asserted; a pack built on one backend and consumed
   on the other is accepted by the listening check in item 3 only.
3. Real-model smoke: build a pack from the reference used on 21 October with the
   installed MLX 1.7B Base, load it through the smoke tool's development grant,
   render one phrase, and confirm it matches the audio-path render in duration and
   listening.
4. Server: `just gate` green, including endpoint, header, rate-limit and startup
   refusal tests. Website: its own gate plus a browser test of the `local` source
   with the simulated helper.
5. End to end on the owner's Mac: local server with a Hexxyi pack, local website,
   extension connected, captions spoken locally, server speech not played, fallback
   on helper disconnect, and no plaintext pack or key anywhere under the viewer's
   home directory after the session.
6. An `embedding` pack and an `icl` pack for Hexxyi are both built and listened to
   before choosing which one the server serves.

## Decisions made in this design

These were settled during the conversation or are the author's calls, marked.

- Qwen stays in the native helper; no in-browser inference. (Owner, by scope.)
- Threat model as stated: at-rest, casual and entitlement protection, not
  debugger-proof. (Author's call, flagged for the owner.)
- Pack contents: speaker embedding always, codec tokens and transcript optionally.
  Both an `icl` and an `embedding` pack are built for Hexxyi and auditioned; the
  server serves `embedding` if it holds up in listening, otherwise `icl`. (Owner,
  22 October.)
- Page-driven flow; the extension and helper stay offline. (Author's call, following
  the repo's existing boundary.)
- Grants come from the server, not the website, as a GET with query parameters, with
  rate limiting. Anyone who can watch the channel can obtain one in v1; sign-in
  gating is deferred. (Owner, 22 October; endpoint shape is the author's call.)
- Cryptography: X25519 plus HKDF-SHA256 plus AES-256-GCM key wrap, Ed25519-signed
  grants, `cryptography` in both Python environments, ephemeral helper key per
  worker process. (Author's call.)
- Pack builder lives in this repo and runs under the helper's configured backend;
  packs are per model identity and record their builder; cross-backend use passes
  by listening. (Author's call.)
- The website keeps one playback path and the adapter gains a generate-only mode.
  (Author's call.)
- One pack serves every target language; `reference_language` is metadata. (Author's
  call, from Qwen's cross-lingual cloning and the 21 October smoke.)
- The `local` source requires a pack-mode helper; other helpers fall back to server
  speech with a clear state. The README's recommended install changes accordingly.
  (Author's call.)
- The helper pins a short list of signing keys; the server publishes its key.
  (Author's call.)
- Synchronization is unchanged. (Owner, by scope.)

## Left to the builder

- Exact framing of the chunked `voice_load` transfer and the worker's length-prefixed
  read path, within the stated bounds.
- The MLX adapter mechanism, provided the parity test holds against the pinned
  mlx-audio version.
- Rate-limit numbers, the grant rate limiter's shape, and how the server identifies a
  client behind the tunnel.
- The settings UI copy and the install link on the website.
- The server command names and the `voice-packs.json` validator's exact checks.
- Buffer zeroisation approach in Python, documented as best effort.

## Owner decisions, 22 October

1. Grants are anonymous in v1: anyone who can watch the channel can obtain one. The
   grant stays on the server's existing HTTP hook. Twitch sign-in gating is deferred
   and, when wanted, fronts the same endpoint from the website.
2. Both an `icl` and an `embedding` pack are built for Hexxyi and listened to before
   the server serves one; `embedding` is preferred if it holds up, otherwise `icl`.
