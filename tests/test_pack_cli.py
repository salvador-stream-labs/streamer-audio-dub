import json, os, subprocess, sys, tempfile, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'native')); import voicepack as vp
FIX = json.loads((ROOT / 'tests/fixtures/voice_grant_v1.json').read_text())
def run(*args, stdin=None):
    return subprocess.run([sys.executable, '-I', str(ROOT / 'native/pack.py'), *args], input=stdin, capture_output=True, text=True, check=True).stdout

class PackCliTests(unittest.TestCase):
    def test_keygen_inspect_and_grant(self):
        keys = json.loads(run('keygen')); self.assertEqual(keys['key_id'], vp.key_id(vp.unb64url(keys['signing_public_b64url'], 32)))
        with tempfile.TemporaryDirectory() as d:
            import base64
            enc = Path(d, 'p.enc'); enc.write_bytes(base64.b64decode(FIX['ciphertext_b64']))
            key = Path(d, 'p.key'); key.write_text(vp.unb64url(FIX['content_key_b64url'], 32).hex())
            shown = json.loads(run('inspect', str(enc))); self.assertEqual(shown['pack_id'], 'hexxyi-test-icl-1'); self.assertEqual(shown['sha256'], FIX['pack_sha256'])
            message = json.loads(run('grant', '--signing-seed', keys['signing_seed_b64url'], '--pack', str(enc), '--key', str(key),
                                     '--helper-public-key', FIX['helper_public_b64url'], '--channel', 'hexxyi',
                                     '--model-id', vp.ModelIdentity.parse(FIX['model']).id, '--pack-url', 'https://x/p'))
            from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
            helper = X25519PrivateKey.from_private_bytes(vp.unb64url(FIX['helper_private_b64url'], 32))
            pack = vp.open_pack(message, pinned_keys=[vp.unb64url(keys['signing_public_b64url'], 32)], helper_private=helper,
                                model=vp.ModelIdentity.parse(FIX['model']), ciphertext=enc.read_bytes(), now=__import__('datetime').datetime.now(__import__('datetime').timezone.utc))
            self.assertEqual(pack.pack_id, 'hexxyi-test-icl-1')
            done = subprocess.run([sys.executable, '-I', str(ROOT / 'native/pack.py'), 'grant', '--signing-seed', keys['signing_seed_b64url'], '--pack', str(enc),
                                   '--key', str(key), '--helper-public-key', FIX['helper_public_b64url'], '--channel', 'hexxyi',
                                   '--model-id', 'qwen3_tts-base-other-12hz', '--pack-url', 'https://x/p'], capture_output=True, text=True, check=False)
            self.assertEqual(done.returncode, 1); self.assertIn('does not match', done.stderr)
            secret = key.read_text()
            self.assertNotIn(secret, done.stderr + done.stdout)

    def test_write_outputs(self):
        import pack
        summary = {'pack_id': 'a-1', 'channel': 'c', 'model': 'm', 'sha256': '0' * 64, 'size': 3, 'file': 'a-1.enc', 'key_file': 'a-1.key'}
        with tempfile.TemporaryDirectory() as d:
            out = Path(d, 'o')
            pack.write_outputs(out, summary, b'abc', b'\x01' * 32)
            self.assertEqual(sorted(p.name for p in out.iterdir()), ['a-1.enc', 'a-1.json', 'a-1.key'])
            self.assertEqual(os.stat(out / 'a-1.key').st_mode & 0o777, 0o600)
            self.assertEqual((out / 'a-1.key').read_text(), '01' * 32)
            self.assertEqual(json.loads((out / 'a-1.json').read_text()), summary)
            with self.assertRaises(FileExistsError):
                pack.write_outputs(out, summary, b'xyz', b'\x02' * 32)
            self.assertEqual((out / 'a-1.enc').read_bytes(), b'abc')

    def test_fixtures(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d, 'f.json'); run('fixtures', str(out)); self.assertEqual(json.loads(out.read_text()), FIX)

if __name__ == '__main__':
    unittest.main()
