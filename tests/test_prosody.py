import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import numpy as np
from scipy import signal

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'native'))
from prosody import shift_pitch
from worker import Engine, Steering
from vendor.runtime_contract import Analysis

FRAMES = json.loads((ROOT / 'tests/fixtures/prosody-feed-v3.json').read_text())


def analysis(pitch=40, status='ok'):
    value = copy.deepcopy(FRAMES[2]['analysis'])
    value['summary']['values']['f0_median_st'] = pitch
    if status == 'unvoiced':
        value['summary']['values']['voicing'] = 0
    value['status'] = status
    return Analysis.parse(value)


class ProsodyTests(unittest.TestCase):
    def test_baseline_uses_prior_valid_observations_and_never_shifts_down(self):
        s = Steering()
        self.assertEqual(s.pitch(None)['reason'], 'missing_analysis')
        self.assertEqual(s.pitch(analysis(status='unvoiced'))['reason'], 'unvoiced')
        self.assertEqual(s.history, [])
        for _ in range(5):
            self.assertEqual(s.pitch(analysis())['reason'], 'warming_up')
        result = s.pitch(analysis(45))
        self.assertEqual(result['requestedSemitones'], 1)
        self.assertEqual(result['baselineCount'], 5)
        self.assertEqual(s.pitch(analysis(30))['requestedSemitones'], 0)
        self.assertEqual(s.pitch(analysis(45), 1)['requestedSemitones'], 1)
        with self.assertRaises(ValueError):
            s.pitch(analysis(45), 3)
        for _ in range(40):
            s.pitch(analysis())
        self.assertEqual(len(s.history), 30)
        self.assertEqual(Steering().pitch(analysis())['reason'], 'warming_up')

    def test_shift_changes_pitch_without_changing_duration_or_clipping(self):
        rate = 24000
        t = np.arange(rate * 2) / rate
        source = (.6 * np.sin(2*np.pi*220*t)).astype(np.float32)
        for semitones in (.5, 1):
            output = shift_pitch(source, semitones)
            self.assertEqual(len(output), len(source))
            self.assertTrue(np.isfinite(output).all())
            self.assertLessEqual(np.max(np.abs(output)), 1)
            frequencies, power = signal.periodogram(output[4000:-4000], rate, nfft=131072)
            peak = frequencies[np.argmax(power)]
            self.assertAlmostEqual(12*np.log2(peak/220), semitones, delta=.03)

    def test_neutral_is_bit_identical_and_short_silent_inputs_are_finite(self):
        source = np.random.default_rng(1).uniform(-1, 1, 15001).astype(np.float32)
        np.testing.assert_array_equal(shift_pitch(source, 0), source)
        for length in (1, 31, 511, 2048, 12001):
            result = shift_pitch(np.zeros(length, dtype=np.float32), 1)
            self.assertEqual(len(result), length)
            self.assertTrue(np.isfinite(result).all())
            self.assertEqual(np.max(np.abs(result)), 0)

    def test_invalid_controls_are_rejected(self):
        for shift in (-1, 1.1, 3, float('nan'), float('inf')):
            with self.assertRaises(ValueError):
                shift_pitch(np.ones(2400), shift)

    def test_voiced_burst_does_not_leave_audible_tails_in_surrounding_silence(self):
        rate = 24000
        t = np.arange(rate) / rate
        harmonics = sum(np.sin(2*np.pi*220*k*t)/k for k in range(1, 9))
        source = np.zeros(rate, dtype=np.float32)
        source[7200:16800] = .2*harmonics[7200:16800]
        result = shift_pitch(source, 1)
        outside = np.r_[result[:6840], result[17160:]]
        self.assertLess(float(outside @ outside) / float(result @ result), 1e-6)

    def test_base_worker_applies_one_shift_across_transport_boundaries_and_falls_back(self):
        from types import SimpleNamespace
        import base64
        rate = 24000
        audio = (.3*np.sin(2*np.pi*220*np.arange(rate*2)/rate)).astype(np.float32)
        for pack in (False, True):
            engine = Engine.__new__(Engine)
            engine.np, engine.config, engine.steering = np, {'mode': 'base', 'backend': 'mlx', 'referenceText': 'hi'}, Steering()
            engine.voice = SimpleNamespace(ref_text='hi') if pack else True
            engine.pack_voice, engine.can_instruct, engine.device = pack, False, 'test'
            engine.reference_audio = engine.dummy_reference = np.zeros(1)
            engine.model = SimpleNamespace(generate=lambda **kw: iter([
                SimpleNamespace(audio=audio[:13579], sample_rate=rate),
                SimpleNamespace(audio=audio[13579:], sample_rate=rate)]))
            for _ in range(5):
                engine.steering.pitch(analysis())
            value = copy.deepcopy(FRAMES[2]['analysis'])
            value['summary']['values']['f0_median_st'] = 45
            job = {'session': value['session'], 'utterance_id': '2', 'text': 'Thank you.', 'language': 'en',
                   't_start': 0, 't_end': 2, 'prosody': value}
            messages = []
            result = engine.synthesize(job, messages.append)
            actual = np.concatenate([np.frombuffer(base64.b64decode(m['data']), '<i2') for m in messages])
            expected = (np.clip(shift_pitch(audio, 1), -1, 1)*32767).astype('<i2')
            np.testing.assert_array_equal(actual, expected)
            self.assertEqual(result['prosody']['appliedSemitones'], 1)
            self.assertEqual((result['samples'], result['chunks']), (len(audio), len(messages)))
            with patch('worker.shift_pitch', side_effect=ValueError('fixture')):
                messages = []
                fallback = engine.synthesize(job, messages.append)
            self.assertEqual(fallback['prosody']['reason'], 'processing_failed')
            self.assertEqual(fallback['prosody']['appliedSemitones'], 0)
            actual = np.concatenate([np.frombuffer(base64.b64decode(m['data']), '<i2') for m in messages])
            np.testing.assert_array_equal(actual, (audio*32767).astype('<i2'))


if __name__ == '__main__':
    unittest.main()
