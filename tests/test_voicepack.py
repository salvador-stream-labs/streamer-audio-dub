import json, sys, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'native'))
import voicepack as vp

CONFIG_1B7 = {'tts_model_type': 'base', 'tts_model_size': '1b7', 'tokenizer_type': 'qwen3_tts_tokenizer_12hz',
              'speaker_encoder_config': {'enc_dim': 2048}, 'talker_config': {'num_code_groups': 16}}
CONFIG_0B6 = {**CONFIG_1B7, 'tts_model_size': '0b6', 'speaker_encoder_config': {'enc_dim': 1024}}

class EncodingTests(unittest.TestCase):
    def test_canonical_json_is_sorted_compact_ascii(self):
        self.assertEqual(vp.canonical({'b': 1, 'a': {'z': 'é', 'y': [1, 2]}}), b'{"a":{"y":[1,2],"z":"\\u00e9"},"b":1}')
    def test_base64url_round_trip_and_length_check(self):
        self.assertEqual(vp.b64url(bytes(32)), 'A' * 43)
        self.assertEqual(vp.unb64url('A' * 43, 32), bytes(32))
        for bad in ['A' * 42, 'A' * 43 + '=', 'A' * 40 + '+/=']: 
            with self.assertRaises(vp.PackError): vp.unb64url(bad, 32)
    def test_key_id_is_sixteen_hex_of_sha256(self):
        self.assertEqual(vp.key_id(bytes(32)), '66687aadf862bd77')

class ModelIdentityTests(unittest.TestCase):
    def test_from_real_config_values(self):
        m = vp.ModelIdentity.from_config(CONFIG_1B7)
        self.assertEqual(m.id, 'qwen3_tts-base-1b7-12hz'); self.assertEqual(m.enc_dim, 2048)
        self.assertEqual(vp.ModelIdentity.from_config(CONFIG_0B6).enc_dim, 1024)
    def test_parse_is_strict(self):
        value = vp.ModelIdentity.from_config(CONFIG_1B7).to_dict()
        self.assertEqual(vp.ModelIdentity.parse(value).id, 'qwen3_tts-base-1b7-12hz')
        for patch in [{'extra': 1}, {'enc_dim': '2048'}, {'tts_model_type': 'voice_design'}, {'tts_model_size': 'A/B'}, {'num_code_groups': 0}]:
            with self.assertRaises(vp.PackError): vp.ModelIdentity.parse({**value, **patch})
        with self.assertRaises(vp.PackError): vp.ModelIdentity.parse({k: v for k, v in value.items() if k != 'tokenizer'})
