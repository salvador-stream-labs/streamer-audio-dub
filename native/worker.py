"""Resident local Qwen runtime. Stdout is NDJSON; model diagnostics go to stderr."""
import base64
from contextlib import redirect_stdout
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import statistics
import sys
import time

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

import voicepack
from vendor.runtime_contract import Analysis
from voicepack import MAX_CIPHERTEXT, ModelIdentity, PackError, b64url, unb64url

LANGUAGES = {'en': 'English', 'ru': 'Russian', 'de': 'German', 'fr': 'French', 'es': 'Spanish',
             'it': 'Italian', 'pt': 'Portuguese', 'ja': 'Japanese', 'ko': 'Korean', 'zh': 'Chinese'}
RATE = 24000
MAX_SECONDS = 45
MAX_LINE = 32768
MAX_LOAD_LINE = 8 * 1024 * 1024
LOAD_PREFIX = b'{"type":"load_voice"'


class Failure(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def read_message(stream):
    """One bounded NDJSON object, or None when the caller must stop reading."""
    line = stream.readline(MAX_LOAD_LINE + 1)
    if not line or len(line) > MAX_LOAD_LINE or (len(line) > MAX_LINE and not line.startswith(LOAD_PREFIX)):
        return None
    try:
        message = json.loads(line)
    except ValueError:
        raise Failure('invalid') from None
    if not isinstance(message, dict):
        raise Failure('invalid')
    return message


def check_reference(path):
    import wave
    ref = Path(path)
    if not ref.is_absolute() or not ref.is_file() or ref.stat().st_size > 10 * 1024**2:
        raise ValueError('Use a local reference WAV')
    with wave.open(str(ref), 'rb') as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or not 3 <= wav.getnframes() / wav.getframerate() <= 12:
            raise ValueError('Reference must be 3–12 seconds of mono PCM16 WAV')


class PackVoice:
    def __init__(self, identity, pinned_keys):
        self.identity, self.pinned_keys = identity, pinned_keys
        self.private = X25519PrivateKey.generate()

    def identity_message(self):
        public = self.private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        return {'voice': 'pack', 'model': self.identity.to_dict(), 'model_id': self.identity.id, 'public_key': b64url(public)}

    def load(self, message, pack_b64, now=None):
        if not isinstance(message, dict) or message.get('v') != voicepack.GRANT_VERSION or not isinstance(pack_b64, str) \
                or len(pack_b64) > MAX_CIPHERTEXT * 4 // 3 + 4:
            raise Failure('invalid')
        try:
            ciphertext = base64.b64decode(pack_b64, validate=True)
        except ValueError:
            raise Failure('invalid') from None
        if len(ciphertext) > MAX_CIPHERTEXT:
            raise Failure('invalid')
        try:
            return voicepack.open_pack(message, pinned_keys=self.pinned_keys, helper_private=self.private,
                                       model=self.identity, ciphertext=ciphertext, now=now or datetime.now(timezone.utc))
        except PackError:
            raise Failure('voice') from None


def validate_job(job):
    if not isinstance(job, dict) or set(job) != {'session', 'utterance_id', 'text', 'language', 't_start', 't_end', 'prosody'}:
        raise ValueError('invalid')
    for key, limit in [('session', 200), ('utterance_id', 200), ('text', 1000)]:
        if not isinstance(job[key], str) or not job[key].strip() or len(job[key].encode('utf-16-le')) // 2 > limit:
            raise ValueError('invalid')
    if job['language'] not in LANGUAGES:
        raise ValueError('invalid')
    for k in ('t_start', 't_end'):
        if type(job[k]) not in (float, int) or not math.isfinite(job[k]) or not 0 <= job[k] <= 2**53 - 1:
            raise ValueError('invalid')
    if not 1 / 16000 <= job['t_end'] - job['t_start'] <= 30:
        raise ValueError('invalid')
    analysis = Analysis.parse(job['prosody']) if job['prosody'] is not None else None
    if analysis and (analysis.session, analysis.utterance_id) != (job['session'], job['utterance_id']):
        raise ValueError('invalid')
    return analysis


class Steering:
    """Bounded, session-relative summary hints, not a reconstruction of source contour."""
    def __init__(self):
        self.history = []

    def instruction(self, analysis):
        if analysis is None or analysis.status != 'ok':
            return ''
        v = analysis.summary.values
        hints = ['Speak naturally and clearly.']
        if len(self.history) >= 5:
            median = lambda name: statistics.median(getattr(row, name) for row in self.history)
            # Pitch only moves upward: avoid introducing an unnaturally low register.
            if v.f0_median_st > median('f0_median_st') + 2:
                hints.append('Use a slightly higher pitch than your usual voice.')
            if v.energy_dbfs > median('energy_dbfs') + 4:
                hints.append('Use a little more vocal energy, without shouting.')
            elif v.energy_dbfs < median('energy_dbfs') - 4:
                hints.append('Speak gently, without whispering.')
            rate = median('rate')
            if rate > 0 and v.rate > rate * 1.2:
                hints.append('Use a slightly brisker speaking pace.')
            elif rate > 0 and v.rate < rate * .8:
                hints.append('Use a slightly more relaxed speaking pace.')
        self.history = (self.history + [v])[-30:]
        return ' '.join(hints)


class Engine:
    def __init__(self, config):
        import numpy as np
        self.np, self.config, self.steering = np, config, Steering()
        model_path = Path(config['modelPath'])
        if not model_path.is_absolute() or not model_path.is_dir():
            raise ValueError('Use a downloaded local model directory')
        model_config = json.loads((model_path / 'config.json').read_text())
        if model_config.get('tts_model_type') != config['mode']:
            raise ValueError('Model type does not match configuration')
        self.can_instruct = config['mode'] == 'custom_voice' and model_config.get('tts_model_size') == '1b7'
        self.prompt = self.reference_audio = self.pack_voice = None
        self.voice = True
        mode = config.get('voice') if config['mode'] == 'base' else 'preset'
        if mode == 'pack':
            identity = ModelIdentity.from_config(model_config)
            self.pack_voice = PackVoice(identity, [unb64url(k, 32) for k in config['voicePublicKeys']])
            self.voice = None
            self.identity = self.pack_voice.identity_message()
        else:
            if mode == 'reference':
                check_reference(config['referenceAudio'])
            identity = ModelIdentity.from_config(model_config)
            self.identity = {'voice': mode, 'model': identity.to_dict(), 'model_id': identity.id}
        if config['backend'] == 'mlx':
            import mlx.core as mx
            from mlx_audio.tts.utils import load_model
            if not mx.metal.is_available():
                raise RuntimeError('Apple GPU unavailable')
            self.mx = mx
            self.device = 'metal'
            self.model = load_model(str(model_path))
            if mode == 'reference':
                from mlx_audio.utils import load_audio
                self.reference_audio = load_audio(config['referenceAudio'], sample_rate=RATE)
        else:
            import torch
            from qwen_tts import Qwen3TTSModel
            requested = config['device']
            self.device = ('cuda:0' if torch.cuda.is_available() else 'cpu') if requested == 'auto' else ('cuda:0' if requested == 'cuda' else requested)
            if self.device.startswith('cuda') and not torch.cuda.is_available():
                raise RuntimeError('CUDA was selected but is unavailable')
            dtype = (torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16) if self.device.startswith('cuda') else torch.float32
            self.model = Qwen3TTSModel.from_pretrained(str(model_path), device_map=self.device, dtype=dtype,
                                                     attn_implementation='sdpa', local_files_only=True)
            if mode == 'reference':
                self.prompt = self.model.create_voice_clone_prompt(ref_audio=config['referenceAudio'],
                    ref_text=config['referenceText'], x_vector_only_mode=False)

    def apply(self, pack):
        raise Failure('voice')  # implemented with the synthesis backends

    def synthesize(self, job, emit):
        if self.voice is None:
            raise Failure('no_voice')
        analysis = validate_job(job)
        instruction = self.steering.instruction(analysis) if self.can_instruct else ''
        cfg, started, count, blocks = self.config, time.monotonic(), 0, 0
        # Bound text-to-audio expansion and generation even if the model never emits EOS.
        tokens = min(540, max(120, len(job['text']) * 3))
        text = ' '.join(job['text'].split())
        def publish(audio, rate):
            nonlocal count, blocks
            a = self.np.asarray(audio, dtype=self.np.float32).reshape(-1)
            if rate != RATE or not a.size or not self.np.isfinite(a).all() or count + a.size > RATE * MAX_SECONDS:
                raise ValueError('Invalid or excessive generated audio')
            for start in range(0, a.size, 12000):
                part = (self.np.clip(a[start:start+12000], -1, 1) * 32767).astype('<i2').tobytes()
                emit({'type': 'pcm', 'index': blocks, 'sampleRate': RATE, 'data': base64.b64encode(part).decode()})
                blocks += 1
            count += a.size
        if cfg['backend'] == 'mlx':
            args = dict(text=text, lang_code=LANGUAGES[job['language']].lower(), max_tokens=tokens,
                        temperature=.7, stream=True, streaming_interval=.5, verbose=False)
            if cfg['mode'] == 'custom_voice':
                args.update(voice=cfg['speaker'], instruct=instruction or None)
            else:
                args.update(ref_audio=self.reference_audio, ref_text=cfg['referenceText'])
            for result in self.model.generate(**args):
                publish(result.audio, result.sample_rate)
        else:
            args = dict(text=text, language=LANGUAGES[job['language']], max_new_tokens=tokens, temperature=.7)
            if cfg['mode'] == 'custom_voice':
                wavs, rate = self.model.generate_custom_voice(**args, speaker=cfg['speaker'], instruct=instruction or None)
            else:
                wavs, rate = self.model.generate_voice_clone(**args, voice_clone_prompt=self.prompt)
            publish(wavs[0], rate)
        if not count or count / RATE >= tokens / 12 * .98:
            raise ValueError('No audio or possible truncated speech')
        return {'sampleRate': RATE, 'samples': int(count), 'chunks': blocks, 'duration': count / RATE,
                'generationSeconds': time.monotonic() - started, 'device': self.device,
                'steering': 'summary_instruction' if instruction else 'neutral',
                'unsupported': ['pitch_contour', 'word_emphasis', 'aligned_pauses', 'exact_duration'] +
                               ([] if self.can_instruct else ['summary_instruction'])}


def run():
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
    protocol = sys.stdout
    def send(value):
        protocol.write(json.dumps(value, allow_nan=False) + '\n')
        protocol.flush()
    engine = None
    while True:
        message = {}
        try:
            message = read_message(sys.stdin.buffer)
            if message is None:
                return
            with redirect_stdout(sys.stderr):
                if message['type'] == 'init' and engine is None:
                    engine = Engine(message['config'])
                    send({'type': 'ready', 'device': engine.device, 'identity': engine.identity})
                elif message['type'] == 'reset' and engine:
                    engine.steering = Steering()
                elif message['type'] == 'load_voice' and engine and engine.pack_voice:
                    pack = engine.pack_voice.load(message['grant'], message['pack'])
                    engine.apply(pack)
                    send({'id': message['id'], 'type': 'voice', 'result': {'loaded': True, 'pack_id': pack.pack_id, 'mode': pack.mode}})
                elif message['type'] == 'speak' and engine:
                    result = engine.synthesize(message['job'], lambda value: send({'id': message['id'], **value}))
                    send({'id': message['id'], 'type': 'done', 'result': result})
                else:
                    raise ValueError('invalid')
        except Exception as error:
            # Do not include a local path, source audio, or text in the browser error.
            print(type(error).__name__, file=sys.stderr)
            if message.get('type') == 'init':
                send({'type': 'fatal'}); return
            code = error.code if isinstance(error, Failure) else 'invalid' if str(error) == 'invalid' else 'failed'
            send({'type': 'error', 'id': message.get('id'), 'error': code})


if __name__ == '__main__':
    run()
