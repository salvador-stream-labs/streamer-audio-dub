import base64, hashlib, json, sys, unittest
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

MODEL = vp.ModelIdentity.from_config({**CONFIG_1B7, 'tts_model_size': 'test',
         'speaker_encoder_config': {'enc_dim': 8}, 'talker_config': {'num_code_groups': 2}})
def embedding(n=8): return (b'\x00\x00\x80\x3f' * n)          # float32 1.0 repeated
def codes(frames=3, groups=2): return (b'\x05\x00\x00\x00' * (frames * groups))
def build(**patch):
    args = dict(pack_id='hexxyi-test-icl-1', channel='hexxyi', label='hexxyi', consent_ref='studio:consent:1', model=MODEL,
                mode='icl', reference_language='ru', ref_text='Привет', spk_embedding=embedding(), ref_codes=codes(),
                builder={'backend': 'mlx', 'package': 'mlx-audio 0.5.9', 'model_sha256': '0' * 64}, built='2026-10-22T12:00:00Z')
    return vp.build_pack(**{**args, **patch})

class PackFormatTests(unittest.TestCase):
    def test_round_trip_icl_and_embedding(self):
        pack = vp.parse_pack(build(), MODEL)
        self.assertEqual((pack.pack_id, pack.mode, pack.ref_text, pack.frames), ('hexxyi-test-icl-1', 'icl', 'Привет', 3))
        self.assertEqual(pack.ref_codes, codes()); self.assertEqual(pack.spk_embedding, embedding())
        only = vp.parse_pack(build(mode='embedding', ref_text=None, ref_codes=None), MODEL)
        self.assertEqual((only.mode, only.ref_text, only.ref_codes, only.frames), ('embedding', None, None, 0))
    def test_header_layout_is_length_prefixed_json(self):
        plaintext = build(); n = int.from_bytes(plaintext[:4], 'little')
        header = json.loads(plaintext[4:4 + n]); self.assertEqual(header['v'], 'voice_pack_v1')
        self.assertEqual(header['tensors']['spk_embedding'], {'dtype': 'float32', 'shape': [8], 'offset': 0, 'length': 32})
        self.assertEqual(header['tensors']['ref_codes']['shape'], [3, 2])
    def test_pack_rejects_model_mismatch(self):
        other = vp.ModelIdentity.parse({**MODEL.to_dict(), 'num_code_groups': 4})
        with self.assertRaises(vp.PackError): vp.parse_pack(build(), other)
        with self.assertRaises(vp.PackError): vp.parse_pack(build(spk_embedding=embedding(9)), MODEL)
    def test_pack_bounds_and_strictness(self):
        for patch in [dict(ref_text='x' * 1001), dict(ref_codes=codes(161)), dict(pack_id='Bad Id'), dict(mode='icl', ref_text=None),
                      dict(mode='embedding', ref_codes=codes()), dict(ref_codes=codes()[:-1])]:
            with self.assertRaises(vp.PackError): vp.parse_pack(build(**patch), MODEL)
        plaintext = bytearray(build()); n = int.from_bytes(plaintext[:4], 'little')
        header = json.loads(plaintext[4:4 + n]); header['extra'] = 1; raw = json.dumps(header).encode()
        tampered = len(raw).to_bytes(4, 'little') + raw + bytes(plaintext[4 + n:])
        with self.assertRaises(vp.PackError): vp.parse_pack(tampered, MODEL)
        with self.assertRaises(vp.PackError): vp.parse_pack(b'\xff\xff\xff\x7f' + bytes(8), MODEL)

def retail(plaintext, edit=None, raw=None):
    n = int.from_bytes(plaintext[:4], 'little')
    if raw is None:
        header = json.loads(plaintext[4:4 + n]); edit(header); raw = json.dumps(header).encode()
    return len(raw).to_bytes(4, 'little') + raw + plaintext[4 + n:]

class PackHostileHeaderTests(unittest.TestCase):
    def test_ref_text_counts_utf16_units(self):
        vp.parse_pack(build(ref_text='😀' * 500), MODEL)
        with self.assertRaises(vp.PackError): build(ref_text='😀' * 501)
    def test_tensor_numbers_must_be_strict_ints(self):
        def edit(h): h['tensors']['spk_embedding'].update(offset=False, length=32.0)
        with self.assertRaises(vp.PackError): vp.parse_pack(retail(build(), edit), MODEL)
        def shape(h): h['tensors']['spk_embedding']['shape'] = [8.0]
        with self.assertRaises(vp.PackError): vp.parse_pack(retail(build(), shape), MODEL)
    def test_tensor_spec_missing_shape(self):
        def edit(h): del h['tensors']['spk_embedding']['shape']
        with self.assertRaises(vp.PackError): vp.parse_pack(retail(build(), edit), MODEL)
    def test_deep_nesting_duplicates_and_constants(self):
        with self.assertRaises(vp.PackError): vp.parse_pack(retail(build(), raw=b'[' * 100000), MODEL)
        good = json.dumps(json.loads(build()[4:4 + int.from_bytes(build()[:4], 'little')])).encode()
        with self.assertRaises(vp.PackError): vp.parse_pack(retail(build(), raw=good[:-1] + b',"v":"voice_pack_v1"}'), MODEL)
        with self.assertRaises(vp.PackError): vp.parse_pack(retail(build(), raw=good[:-1] + b',"x":NaN}'), MODEL)

KEY = bytes(range(32))
class EncryptionTests(unittest.TestCase):
    def test_encrypt_decrypt_round_trip_and_public_header(self):
        plaintext = build(); enc = vp.encrypt_pack(plaintext, KEY)
        self.assertEqual(vp.decrypt_pack(enc, KEY), plaintext)
        header = vp.public_header(enc)
        self.assertEqual(header, {'v': 'voice_pack_enc_v1', 'pack_id': 'hexxyi-test-icl-1', 'channel': 'hexxyi',
                                  'model': MODEL.to_dict(), 'cipher': 'aes-256-gcm', 'size': len(plaintext)})
    def test_header_is_authenticated(self):
        enc = bytearray(vp.encrypt_pack(build(), KEY)); n = int.from_bytes(enc[:4], 'little')
        enc[4:4 + n] = enc[4:4 + n].replace(b'"channel":"hexxyi"', b'"channel":"hexxyj"')
        with self.assertRaises(vp.PackError): vp.decrypt_pack(bytes(enc), KEY)
        with self.assertRaises(vp.PackError): vp.decrypt_pack(vp.encrypt_pack(build(), KEY), bytes(32))
    def test_ciphertext_bounds(self):
        with self.assertRaises(vp.PackError): vp.public_header(b'\x00\x00\x40\x00' + bytes(10))
        with self.assertRaises(vp.PackError): vp.decrypt_pack(bytes(vp.MAX_CIPHERTEXT + 1), KEY)
        with self.assertRaises(vp.PackError): vp.encrypt_pack(build(), bytes(16))
    def test_public_header_rejects_hostile_input(self):
        def wrap(raw): return len(raw).to_bytes(4, 'little') + raw + bytes(40)
        good = json.dumps(vp.public_header(vp.encrypt_pack(build(), KEY))).encode()
        for raw in [b'[' * 100000, good[:-1] + b',"v":"voice_pack_enc_v1"}', good[:-1] + b',"x":NaN}', good[:-1] + b',"x":1}',
                    good.replace(b'aes-256-gcm', b'none'), good.replace(b'"hexxyi"', b'"../x"', 1), b'\xff']:
            with self.assertRaises(vp.PackError): vp.public_header(wrap(raw))
    def test_encrypt_uses_fresh_nonce_and_rejects_bad_plaintext(self):
        a, b = vp.encrypt_pack(build(), KEY), vp.encrypt_pack(build(), KEY)
        self.assertNotEqual(a, b)
        n = int.from_bytes(a[:4], 'little')
        self.assertEqual(vp.encrypt_pack(build(), KEY, nonce=bytes(12))[4 + n:16 + n], bytes(12))
        with self.assertRaises(vp.PackError): vp.encrypt_pack(b'\x01', KEY)
        with self.assertRaises(vp.PackError): vp.encrypt_pack(build(), KEY, nonce=bytes(8))

from datetime import datetime, timedelta, timezone
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
NOW = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)
SEED = bytes([3]) * 32
def issued(enc, helper, **patch):
    args = dict(signing_seed=SEED, channel='hexxyi', pack_id='hexxyi-test-icl-1', pack_sha256=hashlib.sha256(enc).hexdigest(),
                pack_url='https://server.streamir.app/voice/hexxyi/pack/x', model=MODEL,
                helper_public_key=helper.public_key().public_bytes_raw(), content_key=KEY, now=NOW)
    return vp.issue_grant(**{**args, **patch})

class GrantTests(unittest.TestCase):
    def setUp(self):
        self.helper = X25519PrivateKey.generate(); self.enc = vp.encrypt_pack(build(), KEY)
        self.pinned = [vp.signing_public_key(SEED)]
    def open(self, message, **patch):
        args = dict(pinned_keys=self.pinned, helper_private=self.helper, model=MODEL, ciphertext=self.enc, now=NOW)
        return vp.open_pack(message, **{**args, **patch})
    def test_issue_verify_open(self):
        message = issued(self.enc, self.helper)
        self.assertEqual(message['grant']['key_id'], vp.key_id(self.pinned[0]))
        self.assertEqual(message['grant']['expires'], '2026-10-22T12:10:00Z')
        self.assertEqual(self.open(message).pack_id, 'hexxyi-test-icl-1')
    def test_rejects_bad_signature_other_key_and_unknown_key_id(self):
        message = issued(self.enc, self.helper)
        bad = json.loads(json.dumps(message)); bad['grant']['pack_url'] = 'https://other/'
        with self.assertRaises(vp.PackError): self.open(bad)
        with self.assertRaises(vp.PackError): self.open(message, pinned_keys=[vp.signing_public_key(bytes(32))])
        with self.assertRaises(vp.PackError): self.open(issued(self.enc, self.helper, signing_seed=bytes(32)))
    def test_rejects_expiry_and_future_issue(self):
        message = issued(self.enc, self.helper)
        with self.assertRaises(vp.PackError): self.open(message, now=NOW + timedelta(seconds=601))
        self.open(message, now=NOW - timedelta(seconds=60))
        with self.assertRaises(vp.PackError): self.open(message, now=NOW - timedelta(seconds=61))
    def test_rejects_wrong_helper_key_model_and_digest(self):
        with self.assertRaises(vp.PackError): self.open(issued(self.enc, X25519PrivateKey.generate()))
        other = vp.ModelIdentity.parse({**MODEL.to_dict(), 'tts_model_size': 'other'})
        with self.assertRaises(vp.PackError): self.open(issued(self.enc, self.helper, model=other))
        with self.assertRaises(vp.PackError): self.open(issued(self.enc, self.helper), ciphertext=self.enc[:-1])
    def test_rejects_header_mismatch(self):
        wrong = vp.encrypt_pack(build(channel='hexxyj'), KEY)
        message = issued(wrong, self.helper)  # grant says hexxyi, header says hexxyj
        with self.assertRaises(vp.PackError): self.open(message, ciphertext=wrong)
    def test_wrong_content_key_fails_after_verification(self):
        with self.assertRaises(vp.PackError): self.open(issued(self.enc, self.helper, content_key=bytes(32)))
    def test_strict_message_shape(self):
        message = issued(self.enc, self.helper)
        for patch in [lambda m: m.update(extra=1), lambda m: m['grant'].update(extra=1), lambda m: m['grant'].pop('key_id'),
                      lambda m: m['grant']['wrap'].update(data='AAAA')]:
            bad = json.loads(json.dumps(message)); patch(bad)
            with self.assertRaises(vp.PackError): self.open(bad)

class FixtureTests(unittest.TestCase):
    def test_fixture_file_matches_generator(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            vp.write_fixtures(d + '/f.json'); fresh = json.loads(Path(d + '/f.json').read_text())
        stored = json.loads((ROOT / 'tests/fixtures/voice_grant_v1.json').read_text())
        self.assertEqual(fresh, stored)
        helper = X25519PrivateKey.from_private_bytes(vp.unb64url(stored['helper_private_b64url'], 32))
        pack = vp.open_pack(stored['grant_message'], pinned_keys=[vp.unb64url(stored['signing_public_b64url'], 32)], helper_private=helper,
                            model=vp.ModelIdentity.parse(stored['model']), ciphertext=base64.b64decode(stored['ciphertext_b64']), now=NOW)
        self.assertEqual(pack.pack_id, 'hexxyi-test-icl-1')
        self.assertEqual(vp.canonical(stored['grant_message']['grant']).decode(), stored['canonical_grant'])
