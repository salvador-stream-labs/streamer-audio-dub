import copy
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import sys
import unittest
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'native'))
from worker import Failure, MAX_LINE, MAX_LOAD_LINE, PackVoice, Steering, lenient_identity, read_message, validate_job
import voicepack as vp
from vendor.runtime_contract import Analysis

FIX = json.loads((ROOT / 'tests/fixtures/voice_grant_v1.json').read_text())
NOW = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)


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


class MessageBoundTests(unittest.TestCase):
    def test_read_message_bounds(self):
        self.assertEqual(read_message(io.BytesIO(b'{"type":"status"}\n')), {'type': 'status'})
        self.assertIsNone(read_message(io.BytesIO(b'')))
        big = b'{"type":"speak","pad":"' + b'x' * MAX_LINE + b'"}\n'
        self.assertIsNone(read_message(io.BytesIO(big)))
        load = b'{"type":"load_voice","pack":"' + b'x' * MAX_LINE + b'"}\n'
        self.assertEqual(read_message(io.BytesIO(load))['type'], 'load_voice')
        self.assertIsNone(read_message(io.BytesIO(b'{"type":"load_voice","pack":"' + b'x' * MAX_LOAD_LINE + b'"}\n')))
        with self.assertRaises(Failure): read_message(io.BytesIO(b'not json\n'))


class PackVoiceTests(unittest.TestCase):
    def test_identity_and_load_from_fixture(self):
        from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
        voice = PackVoice(vp.ModelIdentity.parse(FIX['model']), [vp.unb64url(FIX['signing_public_b64url'], 32)])
        self.assertEqual(voice.identity_message()['voice'], 'pack'); self.assertEqual(len(voice.identity_message()['public_key']), 43)
        voice.private = X25519PrivateKey.from_private_bytes(vp.unb64url(FIX['helper_private_b64url'], 32))
        pack = voice.load(FIX['grant_message'], FIX['ciphertext_b64'], now=NOW)
        self.assertEqual(pack.pack_id, 'hexxyi-test-icl-1')
        with self.assertRaises(Failure) as c: voice.load(FIX['grant_message'], FIX['ciphertext_b64'][:-8], now=NOW)
        self.assertEqual(c.exception.code, 'voice')
        with self.assertRaises(Failure) as c: voice.load({'v': 'other'}, FIX['ciphertext_b64'], now=NOW)
        self.assertEqual(c.exception.code, 'invalid')
        with self.assertRaises(Failure) as c: voice.load(FIX['grant_message'], 'not base64!', now=NOW)
        self.assertEqual(c.exception.code, 'invalid')
        fresh = PackVoice(vp.ModelIdentity.parse(FIX['model']), [vp.unb64url(FIX['signing_public_b64url'], 32)])
        with self.assertRaises(Failure): fresh.load(FIX['grant_message'], FIX['ciphertext_b64'], now=NOW)  # bound to another key


class IdentityTests(unittest.TestCase):
    def test_custom_voice_config_without_speaker_encoder(self):
        config = {'tts_model_type': 'custom_voice', 'tts_model_size': '1b7',
                  'tokenizer_type': 'qwen3_tts_tokenizer_12hz', 'talker_config': {'num_code_groups': 16}}
        identity = lenient_identity('preset', config)
        self.assertEqual(identity['voice'], 'preset'); self.assertNotIn('public_key', identity)
        self.assertEqual(identity['model_id'], 'qwen3_tts-custom_voice-1b7-12hz')
        self.assertEqual(lenient_identity('reference', {})['model_id'], 'qwen3_tts-unknown-unknown-unknown')
        odd = lenient_identity('reference', {'tts_model_type': 'base', 'tts_model_size': 'x' * 200, 'tokenizer_type': 'Weird/Tok'})
        self.assertEqual(odd['model_id'], 'qwen3_tts-base-unknown-unknown'); self.assertLessEqual(len(odd['model_id']), 64)
        self.assertLessEqual(len(lenient_identity('preset', {k: 'a' * 16 for k in ('tts_model_type', 'tts_model_size', 'tokenizer_type')})['model_id']), 64)


if __name__ == '__main__': unittest.main()
