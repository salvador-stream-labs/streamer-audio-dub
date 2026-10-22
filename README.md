# Streamir: Local Qwen Voice

A Chrome extension and local helper that generate speech on the viewer's computer.
The Streamir web page owns the embedded player, captions, chat translation and reply
composition. This extension does not translate text, render captions, inspect
Twitch chat or connect to an LLM subscription.

**Development integration, not yet connected to the live viewer.** The user changed
this scope on 21 October 2026. The requested coordination session,
`streamir-server-2010`, could not be contacted because its local session connector
was offline. Its saved conversation and current repository were inspected. The
current server still publishes `feed_v1`, which has no intonation event. The new
page/server adapter must be agreed before enabling the live connection. See
[the local voice interface and outstanding server work](docs/local-voice.md).

## What works

- Explicitly connect one viewer tab through the extension action. No persistent
  host permissions, automatic Twitch injection or local listening HTTP server.
- A Chrome native-messaging helper runs a resident Qwen process. Model weights
  remain on the user's computer; runtime downloads are disabled.
- MLX/Metal on Apple Silicon, or PyTorch/CUDA on Linux with an NVIDIA GPU. Explicit
  CPU mode is available. GPU selection is reported; CPU fallback is never labelled GPU.
- Qwen CustomVoice 1.7B accepts conservative summary-based delivery instructions.
  Qwen Base supports a local reference voice. Its lack of instruction steering is
  reported explicitly, rather than silently treating it as supported.
- Bounded generation, deduplication, cancellation, stale-result suppression, PCM
  delivery, and page-side audio scheduling. There is no overlapping speech backlog.
- A page adapter that waits for a source-to-playback clock mapping. The page can
  separately offer an explicit `as-ready` mode for delayed, unsynchronized audio.

The existing provider/OAuth/Claude helper, chat composer, caption overlay, direct
viewer feed client and old fingerprint scheduler have been removed. The old
extension credential is removed from Chrome local storage on startup. An old
`app.streamir.composer` registration or credentials already installed on disk are
not used or modified by this helper.

## Install for development

Requires Node.js 22+, Chrome 138+, Python 3.11, and FFmpeg for reference-audio loading.
The installer supports macOS and
Linux; a Windows native-host installer has not been implemented. Model downloads
are several gigabytes. No model is downloaded by loading the extension.

```sh
npm ci
npm run build
```

Load `dist/` using **Load unpacked** at `chrome://extensions`, then open the
extension's **Install & setup** page for its ID.

For Apple Silicon:

```sh
python3.11 -m venv .venv-qwen
.venv-qwen/bin/python -m pip install -r native/requirements-mlx.txt
.venv-qwen/bin/hf download mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit --local-dir models/qwen
```

For NVIDIA/Linux, create the same environment and install a CUDA-enabled PyTorch
build appropriate to the installed driver using the [PyTorch installer](https://pytorch.org/get-started/locally/), then:

```sh
.venv-qwen/bin/python -m pip install -r native/requirements-torch.txt
.venv-qwen/bin/hf download Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice --local-dir models/qwen
```

For repeatable deployment, supply the chosen model commit with `hf download --revision`
and record that revision with the installation. The development instructions above
use the current model release; dependency pins are in `native/requirements-*.txt`.

Create the ignored `voice-config.json`, replacing paths with absolute paths:

```json
{
  "python": "/absolute/path/to/.venv-qwen/bin/python",
  "modelPath": "/absolute/path/to/models/qwen",
  "backend": "mlx",
  "device": "metal",
  "mode": "custom_voice",
  "speaker": "Ryan"
}
```

For NVIDIA use `backend: "torch"`, `device: "cuda"`. PyTorch's `auto` selects CUDA
when available and otherwise CPU; `cpu` explicitly selects CPU. MLX requires Metal.

To use a prepared streamer reference voice, download the matching **Base** model
instead, set `mode: "base"`, and replace `speaker` with `referenceAudio` (an absolute
path to a 3–12 second mono PCM16 WAV) and `referenceText` (its transcript). Use a
model directory distinct from the CustomVoice directory. Base mode currently uses
that fixed reference and reports summary instruction steering as unsupported. A
streamer voice plus measured intonation needs further reference/prompt integration;
it is not achieved just by sending metadata to Base. Qwen documents the different
[CustomVoice and Base interfaces](https://github.com/QwenLM/Qwen3-TTS).

Test the model before registering it:

```sh
node native/smoke.mjs voice-config.json /tmp/streamir-voice.wav
```

## Streamer voice pack

In pack mode the streamer's voice is not configured on the viewer's computer. The
viewer page obtains an encrypted voice pack and a signed grant from Streamir and hands
them to the helper. Install the 1.7B Base 4-bit MLX model for this mode (CustomVoice
above remains the alternative when no pack is used):

```sh
.venv-qwen/bin/hf download mlx-community/Qwen3-TTS-12Hz-1.7B-Base-4bit --local-dir models/qwen-base
```

```json
{
  "python": "/absolute/path/to/.venv-qwen/bin/python",
  "modelPath": "/absolute/path/to/models/qwen-base",
  "backend": "mlx",
  "device": "metal",
  "mode": "base",
  "voice": "pack",
  "voicePublicKeys": ["<production key, published at GET /voice/public-key>"]
}
```

There are no `referenceAudio` or `referenceText` fields in pack mode. The helper only
accepts grants signed by one of the pinned `voicePublicKeys` (one to four keys).

The owner builds a pack from a reference recording with the helper's own model
(this writes the `.enc` pack, its public `.json` summary and a `.key` content key):

```sh
node native/pack.mjs build --config voice-config.json --reference REF.wav --transcript "TEXT" \
  --reference-language ru --channel NAME --label LABEL --consent-ref REF --mode icl --out DIR
node native/pack.mjs inspect --config voice-config.json PACK.enc
```

`--mode` is `icl` (reference audio codes and transcript) or `embedding` (speaker
embedding only). Verify a pack end to end, with a throwaway signing key and a
development grant instead of the production server:

```sh
node native/smoke.mjs voice-config.json /tmp/streamir-pack.wav --pack PACK.enc --key PACK.key
```

Python tests for the pack format and worker run with
`PYTHON=.venv-qwen/bin/python npm run test:python`.

Threat model. The pack is decrypted only in the helper's memory, and the voice is
not stored on your computer: the pack and its key are never written to disk by the
helper, and a worker restart discards them. This does not make extraction
impossible. A determined viewer with a debugger could still extract the conditioning
from the helper while it runs. Revoking a pack or key stops new sessions from
obtaining a grant; it does not recall a voice already loaded into a running helper.

Register the helper using the extension ID shown on its setup page:

```sh
node native/install.mjs YOUR_CHROME_EXTENSION_ID /absolute/path/to/voice-config.json
```

The installer writes a per-user `app.streamir.qwen` native-host registration and a
launcher under `~/.config/streamir-qwen/<extension-id>/`. It does not install a
background daemon. The model starts when the connected page requests warmup or
speech and exits when the native connection closes. Keep this checkout and its
Python environment in place. `STREAMIR_INSTALL_ROOT` redirects registration into
a staging directory for tests.

Once the page integration exists, open the viewer, click **Connect this viewer**
in the extension, then enable local voice in the page. The connection grants that
page access to local speech synthesis until it is disconnected or closed.

## Page integration and verification

`dist/viewer-local-voice.js` exports `LocalVoice` for the viewer page to import.
Its public interface is documented in [docs/local-voice.md](docs/local-voice.md).
The page owns its AudioContext, playback-clock mapping and original audio volume.
The extension never assumes that message arrival time matches the Twitch picture.

```sh
npm test
npm run test:python
npm run build
npm run test:browser
```

The tests cover native framing, request bounds, model lifecycle, queue expiry,
reset/cancellation, playback timing, browser message delivery and responsive setup.
The browser test uses a simulated native helper. It does not establish live Twitch
sync or CUDA performance.

A real local smoke check on 21 October 2026 used the already-installed MLX Qwen
1.7B Base 4-bit model and an existing reference: 4.08 seconds of 24 kHz speech,
9 PCM blocks, 1.96 seconds of generation on Metal. This excludes initial model
load and is one short phrase, not a latency or voice-quality benchmark. The
CustomVoice steering path and CUDA path still need real-model qualification.

A real-model smoke on 22 October 2026 used the same MLX 1.7B Base 4-bit model on
Metal with development grants (a throwaway signing key) for the two packs built from
the streamer reference: `icl` 3.68 seconds of speech, 1.69 seconds of generation;
`embedding` 2.08 seconds, 0.92 seconds; both loaded with `loaded: true`. The reference-mode
render of the same phrase was 4.56 seconds, 2.44 seconds of generation. Listening,
whether either pack sounds like the streamer, and the `icl` versus `embedding` choice
belong to the owner and are pending.
