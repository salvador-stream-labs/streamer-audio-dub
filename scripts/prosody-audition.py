"""Generate one local Qwen phrase, then compare exactly the same take at 0/+1 st.

Usage: <helper-python> scripts/prosody-audition.py /path/voice-config.json /local/output
Requires an installed Base/reference model. No downloads, upload or service restart.
"""
import base64
import json
import os
from pathlib import Path
import sys
import time
import wave

os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import numpy as np
from worker import Engine
from prosody import shift_pitch


def main():
    config_path, destination = map(Path, sys.argv[1:])
    config = json.loads(config_path.read_text())
    if config['mode'] != 'base' or config.get('voice', 'reference') != 'reference':
        raise ValueError('Use an installed Base/reference configuration for the audition')
    config['pitchCapSemitones'] = 0
    engine = Engine(config)
    parts = []
    metrics = engine.synthesize({'session': 'local-audition', 'utterance_id': '1',
        'text': 'Oh, really? I did not expect that. Thank you so much!', 'language': 'en',
        't_start': 0, 't_end': 4, 'prosody': None},
        lambda m: parts.append(np.frombuffer(base64.b64decode(m['data']), '<i2')))
    original = np.concatenate(parts)
    audio = original.astype(np.float32) / 32768
    destination.mkdir(parents=True, exist_ok=True)
    results = []
    for shift in (0, 1):
        started = time.monotonic()
        processed = shift_pitch(audio, shift)
        pcm = original if shift == 0 else (np.clip(processed, -1, 1)*32767).astype('<i2')
        name = f'pitch-plus-{shift}.wav'
        with wave.open(str(destination / name), 'wb') as f:
            f.setnchannels(1); f.setsampwidth(2); f.setframerate(24000); f.writeframes(pcm.tobytes())
        results.append({'file': name, 'semitones': shift, 'samples': len(pcm),
                        'processingSeconds': time.monotonic()-started,
                        'peak': float(np.max(np.abs(processed)))})
    report = {'generation': metrics, 'comparisons': results,
              'listening': 'Pending human comparison of identity, consonants, pitch naturalness and phrase endings.'}
    (destination / 'report.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
