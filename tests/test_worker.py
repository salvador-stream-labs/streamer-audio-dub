import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'native'))
from worker import Steering, validate_job
from vendor.runtime_contract import Analysis


def analysis():
    return {'version': 'source_prosody_v1', 'session': 'session', 'utterance_id': '1',
            'audio_sha256': '0' * 64, 'sample_count': 32000, 'source_kind': 'stream_mix',
            'extractor': {'id': 'studio-python-v1', 'revision': '0' * 64, 'config_sha256': '0' * 64},
            'status': 'ok', 'summary': {'version': 'prosody_v1', 'implementation': 'studio-python-v1',
            'values': {'f0_median_st': 40, 'f0_iqr_st': 3, 'energy_dbfs': -20, 'energy_sd_db': 2,
                       'rate': 3, 'pause_ratio': .1, 'voicing': .8, 'duration_s': 2}},
            'contour': None, 'audio_ref': None, 'analysis_ms': 12}


def job():
    return {'session': 'session', 'utterance_id': '1', 'text': 'Thank you.', 'language': 'en',
            't_start': 10, 't_end': 12, 'prosody': analysis()}


class WorkerTests(unittest.TestCase):
    def test_pinned_server_contract(self):
        pin = json.loads((ROOT / 'native/vendor/pin.json').read_text())
        self.assertEqual(hashlib.sha256((ROOT / 'native/vendor/runtime_contract.py').read_bytes()).hexdigest(), pin['sha256'])

    def test_real_analysis_shape_and_identity(self):
        self.assertEqual(validate_job(job()).status, 'ok')
        for key, value in [('session', 'wrong'), ('utterance_id', 'wrong'), ('language', 'xx'), ('text', '😀' * 501), ('t_start', True)]:
            bad = job(); bad[key] = value
            with self.assertRaises(ValueError): validate_job(bad)

    def test_rejects_unsupported_contour_and_invalid_summary(self):
        bad = job(); bad['prosody']['contour'] = [1, 2]
        with self.assertRaises(ValueError): validate_job(bad)
        bad = job(); bad['prosody']['summary']['values']['duration_s'] = 3
        with self.assertRaises(ValueError): validate_job(bad)

    def test_session_relative_hints_and_no_downward_pitch(self):
        steering = Steering(); base = analysis()
        for _ in range(5): steering.instruction(Analysis.parse(base))
        higher = copy.deepcopy(base); higher['summary']['values'].update(f0_median_st=45, energy_dbfs=-12, rate=4)
        instruction = steering.instruction(Analysis.parse(higher))
        self.assertIn('higher pitch', instruction); self.assertIn('brisker', instruction)
        lower = copy.deepcopy(base); lower['summary']['values']['f0_median_st'] = 20
        self.assertNotIn('lower pitch', steering.instruction(Analysis.parse(lower)))
        self.assertEqual(steering.instruction(None), '')


if __name__ == '__main__': unittest.main()
