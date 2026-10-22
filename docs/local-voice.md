# Local voice interface

Status: implemented extension-local boundary; **not an agreed replacement for the
server's viewer-feed-v1 contract**. Coordination with `streamir-server-2010` is
pending because its session connector was offline on 21 October 2026. No server
endpoint, deployment or live-feed change has been made by this extension.

## Ownership

- Server: original speech analysis, translation, authoritative intonation metadata,
  source clock, utterance identity and any approved voice reference distribution.
- Viewer page: embedded Twitch player, chat/replies, captions, voice selection,
  playback-clock mapping, user-initiated audio activation, player volume and reset events.
- Extension: permission for the selected tab, validation and native messaging.
- Local helper: one warm Qwen model, synthesis, device reporting and bounded PCM output.

The local boundary contains no shell commands, model downloads, arbitrary paths or
provider credentials. The model, interpreter and optional voice reference are chosen
in a local configuration, not supplied by the page. Input text is spoken as text;
it is never an instruction to a general-purpose agent.

## Viewer API

Copy the built `dist/viewer-local-voice.js` into the viewer's assets. Instantiate
`LocalVoice` with an AudioContext and these options:

| Option | Meaning |
| --- | --- |
| `targetTime(job)` | Return the job's target start on that AudioContext clock; return `null` without a reliable mapping. |
| `timing` | `synchronized` by default; explicit `as-ready` plays delayed audio without claiming picture alignment. |
| `maxLateSeconds` | Default 20, configurable 0–60; discard older speech, including time spent waiting behind another dub. |
| `onState(state)` | Loading, readiness/device, generation metrics, clock wait, playback lateness, skips and disconnect. |
| `onSpeaking(boolean)` | Page hook for ducking/restoring its original audio. |

Call `await voice.start()` directly from the page's enable-local-voice click.
It resumes audio while user activation is available, checks the extension and
warms the model. Catch errors and show the helper setup instructions.

Call `await voice.speak(job)` for each complete translated utterance plus its
matching analysis. It resolves with generation metrics after the complete audio
has arrived, while the scheduler separately handles playback. Catch rejected
requests; failed or cancelled voice must not interrupt captions or chat.

A job has exactly these fields:

```json
{
  "session": "producer-session",
  "utterance_id": "42",
  "text": "Thank you for joining us.",
  "language": "en",
  "t_start": 10.0,
  "t_end": 12.0,
  "prosody": null
}
```

`prosody` may be null (neutral) or a full `source_prosody_v1` Analysis matching
`session` and `utterance_id`. Its schema is already defined by the server/Studio
internal runtime contract. A byte-identical copy and SHA-256 pin are stored in
`native/vendor/`; the worker uses its actual `Analysis.parse`, not guessed
field names. **The server does not yet publish this object to viewers.** The new
wire adapter must specify how source session identity and local hello generation
are represented without rewriting the authoritative analysis identity. This
boundary's explicit `reset()` also invalidates local generations even when the
source session/epoch repeats. Until that adapter is agreed, use the authoritative
analysis session unchanged and reset on every hello.

Limits: text ≤1,000 UTF-16 code units, source span 1/16,000–30 seconds, known Qwen
language code, analysis payload ≤8,192 code units. Larger server utterances need
an agreed segmentation policy; do not silently truncate text or prosody. Local
support for ten language codes does not imply the current server offers them.
Unknown fields and versions fail. Missing/failed/unvoiced analysis uses neutral
speech. Unsupported non-null contours fail under the pinned server schema.

Call `await voice.reset()` on every hello, feed reconnect, channel change, pause,
seek, advertisement, player replacement or discontinuous clock correction. This
stops current audio, restores original volume through the hook, rejects old
requests and cancels queued/active inference. A repeated epoch still resets.
Do not feed jobs while paused or in an advertisement. Resume scheduling only
with a fresh valid clock mapping. Call `voice.close()` when removing the adapter;
closing the tab or disconnecting the extension also releases the model.

The current browser bridge uses same-window, same-origin `postMessage`:
`source: "streamir-viewer"`, `v: "local_voice_v1"`, a unique `id`, and `type` of
`status`, `warmup`, `speak` (with `job`) or `reset`. Responses use
`source: "streamir-local-voice"`. This is a page-to-extension interface, not the
server WebSocket protocol. Native replies can carry indexed `pcm` events followed
by `value` metadata or an `error`. PCM is mono little-endian signed 16-bit at 24 kHz.
Each worker block is at most 12,000 samples, far below Chrome's 1 MB host message
limit. The page verifies all chunk indices and final sample/chunk counts.

## Timing and resource policy

There is one active synthesis and at most three queued requests. Queued requests
expire after 45 seconds; active requests, including cold model loading, have a
120-second watchdog. Generation is limited to 540 codec tokens and 45 seconds of
audio. Duplicate utterances cannot be replayed within a generation. The model
stays resident between utterances. Reset during generation kills that worker;
reset while idle keeps the model and clears its prosody history. Disconnect kills it.

MLX emits chunks as it generates. PyTorch's high-level API returns buffered audio,
which is split into transport chunks. The page currently waits for successful
completion before playback, so incomplete or runaway output is never played.
This is buffered sentence playback, not a low-latency streaming-playback claim.

A verified source offset maps `t_start` onto the AudioContext clock. The page
scheduler holds early audio, plays late audio only within the configured tolerance,
never overlaps dubs, and expires held audio after 45 seconds. Playback itself has
at most three queued phrases. It uses actual generated duration, not the source
span, to determine completion. A slow computer causes visible skips, not an
unbounded queue. `onSpeaking` can precede actual output by at most 50 ms to allow
a duck attack.

A source-to-playback mapping still needs to be supplied by the new viewer. Arrival
time is not a mapping. Twitch's embed is not an arbitrary live-video delay buffer;
its documented seek method applies to VOD. A controlled replay/buffering path or
measured live mapping must be confirmed separately. See the [Twitch embed API](https://dev.twitch.tv/docs/embed/video-and-clips).

## Intonation capabilities

The default setup uses Qwen 1.7B CustomVoice and a preset speaker. For voiced source,
summary measurements are converted into conservative natural-language hints.
After five utterances, pitch, energy and rate are compared to the last thirty
utterances in that session. Pitch hints only request an upward change. These are
requested controls, not a measured guarantee that Qwen followed them.

Base mode caches a fixed reference (and on PyTorch its clone prompt), preserving
that reference voice. It reports summary instructions as unsupported. Applying
server intonation while retaining a specific streamer voice needs a qualified
reference bank/live-reference adapter or calibrated post-processing. The current
implementation does not claim to solve that missing part.

Both modes explicitly report pitch-contour, word-emphasis, aligned pauses and
exact duration fitting as unsupported. Existing server analysis exposes summary
measurements and a null contour; it does not establish word alignment. See the
[Qwen model interfaces](https://github.com/QwenLM/Qwen3-TTS) and
[MLX-Audio implementation](https://github.com/Blaizzy/mlx-audio).

## Questions for the server/page session

1. Where is the replacement viewer page and its feed contract?
2. How are translated utterances joined with authoritative Analysis, including
   deadlines, missing-analysis fallback, source session and hello generation?
3. Which voice/reference package should viewers download for Hexxyi, and what
   intonation mechanism is expected for that cloned voice?
4. What clock mapping or controllable playback buffer can the page provide?
5. How does the page select local speech instead of server `say` audio, avoiding
   duplicate playback while preserving normal caption publication?

The extension does not invent a new server event, fetch private Studio voice packs,
or treat the old `feed_v1` caption as sufficient for the new intonation feature.
