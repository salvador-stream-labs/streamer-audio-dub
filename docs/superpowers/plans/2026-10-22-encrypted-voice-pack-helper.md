# Encrypted Voice Pack: Helper, Extension and Page Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The local Qwen helper accepts a server-issued, grant-bound encrypted voice pack through the existing page bridge, turns it into Qwen clone conditioning in memory, and speaks captions with it; the owner can build and locally smoke-test such packs.

**Architecture:** A dependency-light Python module `native/voicepack.py` owns the pack format, encryption, canonical JSON and grant verification; the server will vendor it byte-for-byte later. The worker gains a pack-mode voice (ephemeral X25519 key, pinned Ed25519 server keys, in-memory conditioning for PyTorch and MLX). The Node host reassembles the chunked ciphertext and forwards one bounded message; the shared contract validates the new request types at every hop; the page adapter gains identity, load, generate-only and transparent reload.

**Tech Stack:** Node 22+ (`node:test`, esbuild, Playwright), Python 3.11 (`unittest`, `cryptography==50.0.2`, numpy via the backends), mlx-audio 0.5.9 or qwen-tts 0.1.1, Chrome 138+ MV3.

**Spec:** `docs/superpowers/specs/2026-10-22-encrypted-voice-pack-design.md`

**Scope of this plan:** this repository only (helper, extension, page adapter, pack builder, smoke). The server endpoints and the website page get their own plans in their repositories; they consume `native/voicepack.py` and `tests/fixtures/voice_grant_v1.json` produced here.

## Global Constraints

- Helper stays offline: no network calls in `native/`; `HF_HUB_OFFLINE=1` unchanged; no page-supplied paths, URLs or code.
- No plaintext pack, content key, key-encryption key or grant is ever written to disk or logged, on any side. Worker stderr carries only exception type names, as today.
- Errors to the page are generic codes: existing ones plus `no_voice` and `voice`.
- Chrome frame bound stays 32 KiB (`native/protocol.mjs`); worker lines stay 32 KiB except one `load_voice` line bounded at 8 MiB and recognised by the prefix `{"type":"load_voice"`.
- Pack plaintext ≤ 1 MiB; ciphertext file ≤ 4 MiB; a transfer part carries ≤ 16 KiB of bytes (21,848 base64 characters); at most 256 parts.
- Grant TTL 600 s; `issued` may be at most 60 s in the future; `key_id` is the first 16 hex characters of SHA-256 of the signing public key; 1–4 pinned keys.
- HKDF-SHA256, salt empty, info `b"streamir voice_grant_v1" + helper_public + server_public`, length 32; AES-256-GCM with 12-byte nonces; X25519; Ed25519. Canonical JSON: `json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)`.
- `ref_text` ≤ 1,000 UTF-16 code units; `ref_codes` ≤ 160 frames; `spk_embedding` length equals the model's `enc_dim` read from `config.json`, never a constant.
- Pins: `cryptography==50.0.2` added to both `native/requirements-*.txt`; mlx-audio and qwen-tts pins unchanged.
- Python tests run as `PYTHON=<helper venv python> npm run test:python`; Node tests as `npm test`; browser test as `npm run build && npm run test:browser`.
- Commit messages: conventional prefix, and end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A grant issued for a different channel or pack than the ciphertext's public header must be rejected before decryption (Task 4 test `test_rejects_header_mismatch`).
2. A worker restart between `voice_identity` and `voice_load` leaves the grant bound to a dead key; the adapter must obtain a fresh identity and grant once, not loop (Task 11 browser assertion `reloaded`).
3. Parts for an unknown, finished or reset transfer, out-of-order parts, and parts after a size overrun must fail with `invalid` and free memory (Task 7 test `voice transfer rejects stray, reordered and oversized parts`).
4. A pack whose embedding length matches but whose `num_code_groups` does not match the local model must be refused (Task 2 test `test_pack_rejects_model_mismatch`).
5. An oversized worker line that is not the `load_voice` message must end the worker, and a `load_voice` line over 8 MiB must too (Task 8 test `test_read_message_bounds`).

---

### Task 1: Canonical JSON, encodings and model identity

**Files:**
- Create: `native/voicepack.py`
- Create: `tests/test_voicepack.py`
- Modify: `native/requirements-mlx.txt`, `native/requirements-torch.txt`, `package.json` (`test:python`)

**Interfaces:**
- Produces, in `native/voicepack.py`:
  - `class PackError(ValueError)`
  - `def canonical(value: dict) -> bytes`
  - `def b64url(data: bytes) -> str` (no padding) and `def unb64url(text: str, length: int | None = None) -> bytes` (raises `PackError` on bad alphabet or wrong length)
  - `def key_id(public_key: bytes) -> str`
  - `@dataclass(frozen=True) class ModelIdentity: family: str; tts_model_type: str; tts_model_size: str; tokenizer: str; enc_dim: int; num_code_groups: int`, with `@classmethod from_config(cls, config: dict) -> ModelIdentity` (reads a model `config.json` dict: `tts_model_type`, `tts_model_size`, `tokenizer_type` → `"12hz"` when it ends with `_12hz`, `speaker_encoder_config.enc_dim`, `talker_config.num_code_groups`, family fixed `"qwen3_tts"`), `@classmethod parse(cls, value: dict) -> ModelIdentity` (strict: exactly these six keys, `tts_model_type in ("base", "custom_voice")`, size and tokenizer match `[a-z0-9_]{1,16}`, `enc_dim` in 1..8192, `num_code_groups` in 1..64), `def to_dict(self) -> dict`, `@property id(self) -> str` giving `f"{family}-{tts_model_type}-{tts_model_size}-{tokenizer}"`.

- [ ] **Step 1: Add the dependency and the test runner switch**

Append `cryptography==50.0.2` to both requirement files. In `package.json` set `"test:python": "\"${PYTHON:-python3}\" -m unittest discover -s tests -p \"test_*.py\""`. Install it into the helper environment: `$PYTHON -m pip install cryptography==50.0.2` where `$PYTHON` is the interpreter named in your `voice-config.json`.

- [ ] **Step 2: Write the failing tests**

```python
# tests/test_voicepack.py
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `PYTHON=$PYTHON npm run test:python`
Expected: FAIL with `ModuleNotFoundError: No module named 'voicepack'`

- [ ] **Step 4: Implement the functions and the dataclass in `native/voicepack.py`**

Module docstring states the module is vendored by the server and must import only the standard library and `cryptography`. `key_id` uses `hashlib.sha256(public_key).hexdigest()[:16]`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `PYTHON=$PYTHON npm run test:python`
Expected: PASS (existing worker tests still pass)

- [ ] **Step 6: Commit**

```bash
git add native/voicepack.py tests/test_voicepack.py native/requirements-mlx.txt native/requirements-torch.txt package.json
git commit -m "feat(voicepack): canonical JSON, encodings and model identity"
```

---

### Task 2: Pack plaintext format

**Files:**
- Modify: `native/voicepack.py`
- Test: `tests/test_voicepack.py`

**Interfaces:**
- Consumes: `ModelIdentity`, `PackError` from Task 1.
- Produces:
  - Constants `PACK_VERSION = "voice_pack_v1"`, `MAX_PLAINTEXT = 1 << 20`, `MAX_REF_FRAMES = 160`, `MAX_REF_TEXT = 1000`, `PACK_ID = r"[a-z0-9][a-z0-9_.-]{0,99}"`.
  - `@dataclass(frozen=True) class Pack: header: dict; spk_embedding: bytes; ref_codes: bytes | None` with properties `pack_id`, `channel`, `mode`, `ref_text` (None for `embedding`), `model: ModelIdentity`, `frames: int` (0 for `embedding`). Tensor bytes are little-endian float32 / int32 exactly as stored; callers use `numpy.frombuffer(pack.spk_embedding, "<f4")` and `numpy.frombuffer(pack.ref_codes, "<i4").reshape(frames, num_code_groups)`.
  - `def build_pack(*, pack_id: str, channel: str, label: str, consent_ref: str, model: ModelIdentity, mode: str, reference_language: str, ref_text: str | None, spk_embedding: bytes, ref_codes: bytes | None, builder: dict, built: str) -> bytes`
  - `def parse_pack(plaintext: bytes, model: ModelIdentity) -> Pack`

- [ ] **Step 1: Write the failing tests**

```python
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
```

`build_pack` validates by parsing its own output, so invalid inputs raise `PackError` inside `build(...)`, which the `with` block still catches.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PYTHON=$PYTHON npm run test:python`
Expected: FAIL with `AttributeError: module 'voicepack' has no attribute 'build_pack'`

- [ ] **Step 3: Implement `build_pack`, `parse_pack` and `Pack`**

Header keys exactly as in the spec example (`v, pack_id, channel, voice{label, consent_ref}, model, mode, reference_language, ref_text (icl only), tensors, built, builder`). `parse_pack` checks: header length ≤ `MAX_PLAINTEXT`, total length ≤ `MAX_PLAINTEXT`, exact key sets at every level, `model` equals the given identity, tensor `offset`/`length` within the tensor area and contiguous, `shape` consistent with `length` and the identity, `ref_codes` values in `0 .. 65535`, `reference_language` matches `[a-z]{2,3}`, `label` ≤ 60 characters, `consent_ref` ≤ 200.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PYTHON=$PYTHON npm run test:python`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add native/voicepack.py tests/test_voicepack.py
git commit -m "feat(voicepack): voice_pack_v1 plaintext format"
```

---

### Task 3: Pack encryption

**Files:**
- Modify: `native/voicepack.py`
- Test: `tests/test_voicepack.py`

**Interfaces:**
- Produces:
  - Constants `ENC_VERSION = "voice_pack_enc_v1"`, `MAX_CIPHERTEXT = 4 << 20`.
  - `def encrypt_pack(plaintext: bytes, content_key: bytes, *, nonce: bytes | None = None) -> bytes` — reads `pack_id`, `channel`, `model` from the plaintext header to build the public header `{"v","pack_id","channel","model","cipher":"aes-256-gcm","size"}`; layout 4-byte LE header length, header JSON (canonical), 12-byte nonce, AES-GCM output with the header bytes as associated data. `nonce` is a test hook; default `os.urandom(12)`.
  - `def public_header(ciphertext: bytes) -> dict` (strict parse, bounds, no decryption)
  - `def decrypt_pack(ciphertext: bytes, content_key: bytes) -> bytes`

- [ ] **Step 1: Write the failing tests**

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PYTHON=$PYTHON npm run test:python`
Expected: FAIL with `AttributeError: ... 'encrypt_pack'`

- [ ] **Step 3: Implement with `cryptography.hazmat.primitives.ciphers.aead.AESGCM`**

`decrypt_pack` maps `InvalidTag` to `PackError`. Both functions reject a key that is not 32 bytes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PYTHON=$PYTHON npm run test:python`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add native/voicepack.py tests/test_voicepack.py
git commit -m "feat(voicepack): AES-256-GCM pack encryption with authenticated public header"
```

---

### Task 4: Grants: issue, verify, unwrap, open, and shared fixtures

**Files:**
- Modify: `native/voicepack.py`
- Create: `tests/fixtures/voice_grant_v1.json` (generated)
- Test: `tests/test_voicepack.py`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - Constants `GRANT_VERSION = "voice_grant_v1"`, `GRANT_TTL_S = 600`, `GRANT_SKEW_S = 60`, `GRANT_INFO = b"streamir voice_grant_v1"`.
  - `def signing_public_key(seed: bytes) -> bytes` (Ed25519 raw public key from a 32-byte seed).
  - `def issue_grant(*, signing_seed: bytes, channel: str, pack_id: str, pack_sha256: str, pack_url: str, model: ModelIdentity, helper_public_key: bytes, content_key: bytes, now: datetime, ttl_s: int = GRANT_TTL_S, server_private: bytes | None = None, nonce: bytes | None = None) -> dict` returning `{"v": GRANT_VERSION, "grant": {...}, "signature": str}` with the grant fields exactly as the spec lists (`v, channel, pack_id, pack_sha256, pack_url, model, key_id, helper_public_key, server_public_key, issued, expires, wrap{nonce, data}`), timestamps as `YYYY-MM-DDTHH:MM:SSZ`. `server_private`/`nonce` are test hooks.
  - `def verify_grant(message: dict, *, pinned_keys: list[bytes], helper_private: X25519PrivateKey, model: ModelIdentity, ciphertext: bytes, now: datetime) -> bytes` returning the content key, applying the spec's check order and raising `PackError` on the first failure.
  - `def open_pack(message: dict, *, pinned_keys, helper_private, model, ciphertext, now) -> Pack` = verify, decrypt, parse, then overwrite the `bytearray` copies of the content key, KEK, shared secret and plaintext it holds (best effort).
  - `def write_fixtures(path: str) -> None` writes deterministic vectors (helper private `bytes([1]) * 32`, server ephemeral private `bytes([2]) * 32`, signing seed `bytes([3]) * 32`, content key `bytes([4]) * 32`, pack nonce `bytes([5]) * 12`, wrap nonce `bytes([6]) * 12`, `now = 2026-10-22T12:00:00Z`, the Task 2 synthetic model and pack) as JSON: `{"model", "plaintext_b64", "ciphertext_b64", "pack_sha256", "helper_private_b64url", "helper_public_b64url", "signing_seed_b64url", "signing_public_b64url", "key_id", "content_key_b64url", "grant_message", "canonical_grant"}`.

- [ ] **Step 1: Write the failing tests**

```python
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
```

Add `import base64, hashlib` at the top of the test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PYTHON=$PYTHON npm run test:python`
Expected: FAIL with `AttributeError: ... 'issue_grant'`

- [ ] **Step 3: Implement grants in `native/voicepack.py`**

Use `cryptography.hazmat.primitives.asymmetric.ed25519`, `.x25519`, `kdf.hkdf.HKDF`, `ciphers.aead.AESGCM`. The signature covers `canonical(grant)`; the wrap's associated data is `canonical(grant without "wrap")`. `verify_grant` performs, in order: strict shapes (grant keys exactly the twelve listed, `v`, base64url lengths 43/16/64-hex, timestamps parse as UTC `Z`), `key_id` lookup among `pinned_keys`, Ed25519 verify, `issued <= now + 60 s`, `expires > now`, helper key equality, model equality, `hashlib.sha256(ciphertext).hexdigest() == pack_sha256`, public header channel/pack id/model equality, then HKDF and AES-GCM unwrap. Map `InvalidSignature` and `InvalidTag` to `PackError`.

- [ ] **Step 4: Generate the fixture file**

Run: `$PYTHON -c "import sys; sys.path.insert(0,'native'); import voicepack; voicepack.write_fixtures('tests/fixtures/voice_grant_v1.json')"`
Expected: file created; commit it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `PYTHON=$PYTHON npm run test:python`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add native/voicepack.py tests/test_voicepack.py tests/fixtures/voice_grant_v1.json
git commit -m "feat(voicepack): signed grants, key wrap and shared test vectors"
```

---

### Task 5: Contract: new request types, part splitting and errors

**Files:**
- Modify: `src/voice/contract.js`
- Test: `tests/voice.test.mjs`

**Interfaces:**
- Produces (exported from `src/voice/contract.js`):
  - `VOICE_PACK_MAX_BYTES = 4194304`, `VOICE_PART_BYTES = 16384`, `VOICE_PART_CHARS = 21848`, `VOICE_PARTS_MAX = 256`.
  - `request(value)` additionally accepts:
    - `{v, id, type: 'voice_identity'}`
    - `{v, id, type: 'voice_load', grant, signature, size, sha256, parts}` where `grant` is an object with `v === 'voice_grant_v1'` and `JSON.stringify(grant).length <= 4096`, `signature` matches `/^[A-Za-z0-9_-]{86}$/`, `size` is an integer `1..VOICE_PACK_MAX_BYTES`, `sha256` matches `/^[0-9a-f]{64}$/`, `parts === Math.ceil(size / VOICE_PART_BYTES)`.
    - `{v, id, type: 'voice_part', load, index, data}` where `load` matches the id pattern, `index` is an integer `0..VOICE_PARTS_MAX - 1`, `data` matches standard base64 `/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/`, non-empty, `length <= VOICE_PART_CHARS`.
  - `packParts(bytes: Uint8Array) -> string[]`: base64 of consecutive `VOICE_PART_BYTES` slices (pure; works in Node and browsers without `Buffer`).
  - `ERRORS.no_voice = 'Load the streamer voice first.'`, `ERRORS.voice = 'The streamer voice could not be loaded.'`.

- [ ] **Step 1: Write the failing tests**

```js
test('voice requests validate identity, load declarations and parts', () => {
  const load = {v: VERSION, id: 'load', type: 'voice_load', grant: {v: 'voice_grant_v1'}, signature: 'A'.repeat(86), size: 20000, sha256: 'a'.repeat(64), parts: 2};
  assert.equal(request({v: VERSION, id: 'i', type: 'voice_identity'}).type, 'voice_identity');
  assert.equal(request(load).parts, 2);
  for (const patch of [{parts: 3}, {size: 0}, {size: VOICE_PACK_MAX_BYTES + 1, parts: 257}, {signature: 'A'.repeat(85)}, {sha256: 'g'.repeat(64)}, {grant: {v: 'other'}}, {grant: {v: 'voice_grant_v1', pad: 'x'.repeat(4096)}}, {extra: 1}]) assert.throws(() => request({...load, ...patch}));
  const part = {v: VERSION, id: 'p0', type: 'voice_part', load: 'load', index: 0, data: 'AAAA'};
  assert.equal(request(part).index, 0);
  for (const patch of [{index: -1}, {index: 256}, {data: ''}, {data: 'AAA'}, {data: 'A'.repeat(VOICE_PART_CHARS + 4)}, {data: 'AA A='}, {load: 'bad id!'}]) assert.throws(() => request({...part, ...patch}));
  assert.equal(ERRORS.no_voice, 'Load the streamer voice first.');
});
test('packParts splits at 16 KiB and encodes without Buffer', () => {
  const bytes = new Uint8Array(VOICE_PART_BYTES * 2 + 1).fill(7);
  const parts = packParts(bytes);
  assert.equal(parts.length, 3); assert.equal(parts[0].length, VOICE_PART_CHARS); assert.equal(parts[2], 'Bw==');
  assert.deepEqual(Buffer.concat(parts.map(p => Buffer.from(p, 'base64'))), Buffer.from(bytes));
});
```

Import `VOICE_PACK_MAX_BYTES, VOICE_PART_BYTES, VOICE_PART_CHARS, ERRORS, packParts` in the test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL with `SyntaxError: ... does not provide an export named 'packParts'`

- [ ] **Step 3: Implement in `src/voice/contract.js`**

`packParts` uses `btoa(String.fromCharCode(...))` on slices small enough to spread (16 KiB is fine) and returns strings.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/voice/contract.js tests/voice.test.mjs
git commit -m "feat(contract): voice identity, load and part requests"
```

---

### Task 6: Helper configuration for pack mode

**Files:**
- Modify: `native/config.mjs`, `native/install.mjs`
- Test: `tests/voice.test.mjs`

**Interfaces:**
- Produces: `config(value)` returns, for `mode: 'base'`, a `voice` field: `'reference'` (default when absent, requires `referenceAudio` and `referenceText` as today) or `'pack'` (requires `voicePublicKeys`, an array of 1–4 strings each matching `/^[A-Za-z0-9_-]{43}$/`, and forbids reference fields). `custom_voice` output is unchanged (no `voice` field). `install.mjs` keeps working: it already guards `access(voice.referenceAudio)` on presence.

- [ ] **Step 1: Write the failing test**

```js
test('pack mode pins one to four server keys and carries no reference files', () => {
  const base = {python: '/python', modelPath: '/model', backend: 'mlx', device: 'metal', mode: 'base'};
  const key = 'A'.repeat(43);
  assert.deepEqual(config({...base, voice: 'pack', voicePublicKeys: [key]}), {...base, voice: 'pack', voicePublicKeys: [key]});
  assert.equal(config({...base, referenceAudio: '/ref.wav', referenceText: 'hi'}).voice, 'reference');
  for (const patch of [{voicePublicKeys: []}, {voicePublicKeys: [key, key, key, key, key]}, {voicePublicKeys: ['A'.repeat(42)]}, {voicePublicKeys: [key], referenceAudio: '/ref.wav'}, {voice: 'preset'}]) assert.throws(() => config({...base, voice: 'pack', ...patch}));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL (`config` throws for `voice: 'pack'`)

- [ ] **Step 3: Implement in `native/config.mjs`**

Return exactly `{python, modelPath, backend, device, mode, voice, voicePublicKeys}` for pack mode and `{..., voice: 'reference', referenceAudio, referenceText}` for reference mode.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add native/config.mjs native/install.mjs tests/voice.test.mjs
git commit -m "feat(config): pack voice mode with pinned server keys"
```

---

### Task 7: Host service: identity, status, chunked load and worker replies

**Files:**
- Modify: `native/service.mjs`
- Test: `tests/voice.test.mjs`

**Interfaces:**
- Consumes: `request`, `VOICE_PART_BYTES` from Task 5.
- Produces, on `VoiceService`:
  - Worker `ready` messages may carry `identity: {voice, model, model_id, public_key?}`; the service stores it as `this.identity` (validated: `voice` in `pack|reference|preset`, `model_id` string ≤ 64, `public_key` 43-char base64url when `voice === 'pack'`) and clears it in `kill()`.
  - `voice_identity` is queued like `warmup`; `dispatch` answers `{value: this.identity}`.
  - `status` value gains `voice: {state: 'loaded', pack_id} | {state: 'none'}` from `this.voice`, set from worker `{type: 'voice', id, result: {loaded, pack_id, mode}}` replies and cleared in `kill()`.
  - `voice_load` opens one transfer (`this.transfer = {id, message, parts: [], bytes: 0, at}`): refused with `busy` when a transfer is open or `this.active?.message.type === 'speak'`; expires like queued requests (`queueAgeMs`) with `expired`.
  - `voice_part` must match `this.transfer.id` and the next index; decoded bytes accumulate and never exceed the declared `size`; each accepted part is answered `{id, value: {index}}`; the last part closes the transfer, checks total size and SHA-256 (`node:crypto`) against the declaration, and on success pushes `{message: {id, type: 'voice_load', grant, signature, pack: <base64 of all bytes>}}` onto the queue. Any failure (stray, out of order, over size, digest mismatch) answers the offending part id with `invalid`, then the load id with `invalid`, and sets `this.transfer = null`.
  - `dispatch` writes the worker line `JSON.stringify({type: 'load_voice', id, grant: {v: 'voice_grant_v1', grant, signature}, pack})` — `type` first.
  - Worker error codes `invalid`, `no_voice`, `voice` pass through; others map to `failed`.
  - `reset()` cancels an open transfer with `cancelled`; `failWorker()` fails it with its error.

- [ ] **Step 1: Write the failing tests**

```js
import {createHash} from 'node:crypto';
import {packParts} from '../src/voice/contract.js';
const grant = {v: 'voice_grant_v1', channel: 'hexxyi'};
function transfer(s, bytes, id = 'load') {
  const parts = packParts(bytes);
  s.receive({id, v: VERSION, type: 'voice_load', grant, signature: 'A'.repeat(86), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), parts: parts.length});
  parts.forEach((data, index) => s.receive({id: `${id}-${index}`, v: VERSION, type: 'voice_part', load: id, index, data}));
}
test('identity and voice state come from the worker and clear on restart', t => {
  const {service: s, workers: w, output: o} = fixture(); t.after(() => s.close());
  s.receive(message('who', 'voice_identity'));
  w[0].respond({type: 'ready', device: 'metal', identity: {voice: 'pack', model: {enc_dim: 8}, model_id: 'qwen3_tts-base-test-12hz', public_key: 'B'.repeat(43)}});
  assert.equal(o.at(-1).value.public_key, 'B'.repeat(43));
  s.receive(message('st', 'status')); assert.deepEqual(o.at(-1).value.voice, {state: 'none'});
  transfer(s, new Uint8Array(10));
  assert.equal(w[0].commands.at(-1).type, 'load_voice'); assert.equal(JSON.stringify(w[0].commands.at(-1)).startsWith('{"type":"load_voice"'), true);
  w[0].respond({type: 'voice', id: 'load', result: {loaded: true, pack_id: 'p', mode: 'icl'}});
  assert.deepEqual(o.at(-1).value, {loaded: true, pack_id: 'p', mode: 'icl'});
  s.receive(message('st2', 'status')); assert.deepEqual(o.at(-1).value.voice, {state: 'loaded', pack_id: 'p'});
  s.receive(message('one')); s.receive(message('reset', 'reset')); await Promise.resolve();
  s.receive(message('st3', 'status')); assert.deepEqual(o.at(-1).value.voice, {state: 'none'});
});
test('voice transfer rejects stray, reordered and oversized parts', t => {
  const {service: s, workers: w, output: o} = fixture(); t.after(() => s.close());
  s.receive(message('warm', 'warmup')); w[0].respond({type: 'ready', device: 'metal'});
  s.receive({id: 'stray', v: VERSION, type: 'voice_part', load: 'nope', index: 0, data: 'AAAA'}); assert.equal(o.at(-1).error, 'invalid');
  const bytes = new Uint8Array(VOICE_PART_BYTES + 5).fill(1), parts = packParts(bytes);
  s.receive({id: 'load', v: VERSION, type: 'voice_load', grant, signature: 'A'.repeat(86), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), parts: 2});
  s.receive({id: 'again', v: VERSION, type: 'voice_load', grant, signature: 'A'.repeat(86), size: 4, sha256: 'a'.repeat(64), parts: 1}); assert.equal(o.at(-1).error, 'busy');
  s.receive({id: 'p1', v: VERSION, type: 'voice_part', load: 'load', index: 1, data: parts[1]}); assert.equal(o.at(-1).error, 'invalid');
  assert.equal(s.transfer, null);
  transfer(s, bytes, 'ok'); w[0].respond({type: 'voice', id: 'ok', result: {loaded: true, pack_id: 'p', mode: 'icl'}});
  s.receive({id: 'big', v: VERSION, type: 'voice_load', grant, signature: 'A'.repeat(86), size: 4, sha256: 'b'.repeat(64), parts: 1});
  s.receive({id: 'big-0', v: VERSION, type: 'voice_part', load: 'big', index: 0, data: packParts(new Uint8Array(10))[0]});   // 10 bytes exceed the declared 4
  assert.equal(o.at(-1).error, 'invalid'); assert.equal(s.transfer, null);
  s.receive({id: 'bad', v: VERSION, type: 'voice_load', grant, signature: 'A'.repeat(86), size: 10, sha256: 'b'.repeat(64), parts: 1});
  s.receive({id: 'bad-0', v: VERSION, type: 'voice_part', load: 'bad', index: 0, data: packParts(new Uint8Array(10))[0]});  // digest mismatch
  assert.equal(o.at(-1).error, 'invalid');
  s.receive({id: 'late', v: VERSION, type: 'voice_part', load: 'bad', index: 1, data: 'AAAA'}); assert.equal(o.at(-1).error, 'invalid');
});
test('load waits behind generation, and worker voice errors reach the page unchanged', t => {
  const {service: s, workers: w, output: o} = fixture(); t.after(() => s.close());
  s.receive(message('one')); w[0].respond({type: 'ready', device: 'metal'});
  s.receive({id: 'load', v: VERSION, type: 'voice_load', grant, signature: 'A'.repeat(86), size: 4, sha256: 'a'.repeat(64), parts: 1}); assert.equal(o.at(-1).error, 'busy');
  w[0].respond({type: 'error', id: 'one', error: 'no_voice'}); assert.equal(o.at(-1).error, 'no_voice');
  transfer(s, new Uint8Array(4)); w[0].respond({type: 'error', id: 'load', error: 'voice'}); assert.equal(o.at(-1).error, 'voice');
});
```

Mark the first test `async`. Add `VOICE_PART_BYTES` to the import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL (identity reply and transfer handling missing)

- [ ] **Step 3: Implement in `native/service.mjs`**

Decode parts with `Buffer.from(data, 'base64')`; refuse a part whose decoded length is not `VOICE_PART_BYTES` unless it is the last; keep `this.transfer` null when idle so tests can assert it. The transfer stores parts as Buffers and concatenates once at the end.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add native/service.mjs tests/voice.test.mjs
git commit -m "feat(host): voice identity, chunked pack transfer and voice state"
```

---

### Task 8: Worker: pack voice, bounded message reading and error codes

**Files:**
- Modify: `native/worker.py`
- Test: `tests/test_worker.py`

**Interfaces:**
- Consumes: `voicepack` (Task 4), fixtures file.
- Produces, in `native/worker.py`:
  - `MAX_LINE = 32768`, `MAX_LOAD_LINE = 8 * 1024 * 1024`, `LOAD_PREFIX = b'{"type":"load_voice"'`.
  - `class Failure(Exception)` with `code: str` (`'invalid' | 'no_voice' | 'voice'`).
  - `def read_message(stream) -> dict | None`: reads one line with `readline(MAX_LOAD_LINE + 1)`; returns `None` (caller exits) on EOF, on a line over `MAX_LOAD_LINE`, or on a line over `MAX_LINE` that does not start with `LOAD_PREFIX`; otherwise the parsed JSON object (a parse error is `Failure('invalid')`).
  - `def check_reference(path: str) -> None` (the current 3–12 s mono PCM16 WAV checks, moved out of `Engine.__init__`).
  - `class PackVoice`: `__init__(self, identity: ModelIdentity, pinned_keys: list[bytes])` stores both as attributes `identity` and `pinned_keys` and generates the X25519 key as attribute `private` (an `X25519PrivateKey`); `identity_message(self) -> dict` = `{'voice': 'pack', 'model': identity.to_dict(), 'model_id': identity.id, 'public_key': b64url(raw public)}`; `load(self, message: dict, pack_b64: str, now: datetime | None = None) -> Pack` decodes standard base64 (bounded `MAX_CIPHERTEXT`), calls `voicepack.open_pack(...)`, raises `Failure('voice')` on `PackError` and `Failure('invalid')` on a malformed envelope.
  - `Engine`: in base mode reads `config['voice']`; for `'pack'` builds `self.pack_voice = PackVoice(ModelIdentity.from_config(model_config), [unb64url(k, 32) for k in config['voicePublicKeys']])` and sets `self.voice = None`; `self.identity -> dict` = pack identity, or `{'voice': 'reference' | 'preset', 'model': ..., 'model_id': ...}` for the other modes. `ready` is sent as `{'type': 'ready', 'device', 'identity': engine.identity}`. `synthesize` raises `Failure('no_voice')` in pack mode when `self.voice is None`. `run()` handles `{'type': 'load_voice', 'id', 'grant', 'pack'}` by `pack = engine.pack_voice.load(message['grant'], message['pack'])`, `engine.apply(pack)` (Task 9), replying `{'id', 'type': 'voice', 'result': {'loaded': True, 'pack_id': pack.pack_id, 'mode': pack.mode}}`; error replies use `error.code` for `Failure`, `'invalid'` for `ValueError('invalid')`, `'failed'` otherwise.

- [ ] **Step 1: Write the failing tests**

```python
import io, base64, json
from datetime import datetime, timezone
import voicepack as vp
from worker import Failure, PackVoice, read_message, MAX_LINE, MAX_LOAD_LINE
FIX = json.loads((ROOT / 'tests/fixtures/voice_grant_v1.json').read_text())
NOW = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)

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
        fresh = PackVoice(vp.ModelIdentity.parse(FIX['model']), [vp.unb64url(FIX['signing_public_b64url'], 32)])
        with self.assertRaises(Failure): fresh.load(FIX['grant_message'], FIX['ciphertext_b64'], now=NOW)  # bound to another key
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PYTHON=$PYTHON npm run test:python`
Expected: FAIL with `ImportError: cannot import name 'Failure'`

- [ ] **Step 3: Implement in `native/worker.py`**

Keep `Engine.__init__` model loading as is; move the reference WAV checks into `check_reference`; add `PackVoice`, `Failure`, `read_message`; replace the `readline(32769)` loop in `run()` with `read_message`. `Engine.apply` is a stub raising `Failure('voice')` until Task 9.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PYTHON=$PYTHON npm run test:python`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add native/worker.py tests/test_worker.py
git commit -m "feat(worker): pack voice identity, grant loading and bounded load line"
```

---

### Task 9: Worker: apply conditioning on PyTorch and MLX, and the parity check

**Files:**
- Modify: `native/worker.py`
- Create: `tests/test_parity.py` (opt-in, real model)

**Interfaces:**
- Produces, on `Engine`:
  - `def conditioning(self, reference: str, ref_text: str | None, mode: str) -> tuple[bytes, bytes | None, int]` returning `(spk_embedding float32 LE bytes of length enc_dim * 4, ref_codes int32 LE bytes in [T, num_code_groups] order or None, frames)`. PyTorch: `self.model.create_voice_clone_prompt(ref_audio=reference, ref_text=ref_text, x_vector_only_mode=(mode == 'embedding'))[0]`; MLX: `audio = load_audio(reference, sample_rate=24000)`, `self.model.extract_speaker_embedding(audio)[0]`, `self.model.speech_tokenizer.encode(audio[None, None, :])[0].T` (ICL only). Calls `check_reference` first.
  - `def apply(self, pack: Pack) -> None`: PyTorch builds `VoiceClonePromptItem(ref_code=torch.tensor(codes) or None, ref_spk_embedding=torch.tensor(embedding), x_vector_only_mode=pack.mode == 'embedding', icl_mode=pack.mode == 'icl', ref_text=pack.ref_text)` into `self.prompt`. MLX stores `self.mlx_voice = {'embedding': mx.array(embedding)[None, :], 'codes': mx.array(codes.T)[None, :, :] or None, 'ref_text': pack.ref_text}`, installs instance-level overrides `self.model.extract_speaker_embedding = lambda audio, sr=24000: self.mlx_voice['embedding']` and `self.model.speech_tokenizer.encode = lambda audio: self.mlx_voice['codes']`, clears `self.model._icl_cache`, and keeps `self.dummy_reference = mx.zeros((24000,), dtype=mx.float32)`. Sets `self.voice = pack`.
  - `synthesize` in MLX pack mode passes `ref_audio=self.dummy_reference` and `ref_text=pack.ref_text` (None for `embedding`); PyTorch passes `voice_clone_prompt=self.prompt` as today.

- [ ] **Step 1: Write the opt-in parity test**

```python
# tests/test_parity.py — runs only with STREAMIR_VOICE_CONFIG=<voice-config.json with a reference voice> and STREAMIR_REFERENCE=<wav> STREAMIR_REFERENCE_TEXT=<text>
import json, os, sys, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]; sys.path.insert(0, str(ROOT / 'native'))
CONFIG = os.environ.get('STREAMIR_VOICE_CONFIG')

@unittest.skipUnless(CONFIG, 'real model parity is opt-in')
class ParityTests(unittest.TestCase):
    def test_pack_conditioning_matches_audio_path(self):
        import numpy as np, voicepack as vp
        from worker import Engine
        config = json.loads(Path(CONFIG).read_text()); config.update(voice='pack', voicePublicKeys=['A' * 43])
        config.pop('referenceAudio', None); config.pop('referenceText', None)
        engine = Engine(config)
        ref, text = os.environ['STREAMIR_REFERENCE'], os.environ['STREAMIR_REFERENCE_TEXT']
        emb, codes, frames = engine.conditioning(ref, text, 'icl')
        identity = engine.pack_voice.identity
        plaintext = vp.build_pack(pack_id='parity', channel='test', label='t', consent_ref='t', model=identity, mode='icl', reference_language='ru',
                                  ref_text=text, spk_embedding=emb, ref_codes=codes, builder={'backend': config['backend'], 'package': 'test', 'model_sha256': '0' * 64}, built='2026-10-22T00:00:00Z')
        engine.apply(vp.parse_pack(plaintext, identity))
        if config['backend'] == 'mlx':
            import mlx.core as mx
            from mlx_audio.utils import load_audio
            audio = load_audio(ref, sample_rate=24000)
            direct = engine.model.__class__.extract_speaker_embedding(engine.model, audio)
            self.assertTrue(np.allclose(np.array(direct[0]), np.frombuffer(emb, '<f4'), atol=1e-5))
            self.assertTrue(np.array_equal(np.array(engine.mlx_voice['codes'][0]).T, np.frombuffer(codes, '<i4').reshape(frames, -1)))
        else:
            item = engine.model.create_voice_clone_prompt(ref_audio=ref, ref_text=text)[0]
            self.assertTrue(np.allclose(item.ref_spk_embedding.float().cpu().numpy(), np.frombuffer(emb, '<f4'), atol=1e-5))
            self.assertTrue(np.array_equal(item.ref_code.cpu().numpy().reshape(frames, -1), np.frombuffer(codes, '<i4').reshape(frames, -1)))
```

- [ ] **Step 2: Run it without the environment to verify it skips, then with the real model to verify it fails**

Run: `PYTHON=$PYTHON npm run test:python` → `skipped`.
Run: `STREAMIR_VOICE_CONFIG=voice-config.json STREAMIR_REFERENCE=<wav> STREAMIR_REFERENCE_TEXT="<text>" $PYTHON -m unittest tests.test_parity -v`
Expected: FAIL with `AttributeError: 'Engine' object has no attribute 'conditioning'`

- [ ] **Step 3: Implement `conditioning` and `apply` in `native/worker.py`**

On MLX, `extract_speaker_embedding` must be overridden on the instance (so `engine.model.__class__.extract_speaker_embedding` still reaches the original for the parity test).

- [ ] **Step 4: Run the parity test with the real model to verify it passes, then run the suite**

Run: the command from Step 2 → PASS; `PYTHON=$PYTHON npm run test:python` → PASS.

- [ ] **Step 5: Commit**

```bash
git add native/worker.py tests/test_parity.py
git commit -m "feat(worker): apply pack conditioning on PyTorch and MLX with parity check"
```

---

### Task 10: Pack builder and development grant tools

**Files:**
- Create: `native/pack.py`, `native/pack.mjs`
- Test: `tests/test_pack_cli.py`

**Interfaces:**
- Consumes: `voicepack`, `worker.Engine.conditioning`.
- Produces `native/pack.py` subcommands (run with the helper interpreter and `-I`):
  - `build --config-json - --reference WAV --transcript FILE --reference-language ru --mode icl|embedding --channel NAME --label TEXT --consent-ref TEXT --out DIR [--pack-id ID]`: reads the validated helper config JSON from stdin, constructs `Engine`, computes conditioning, builds and encrypts the pack in memory with a fresh `os.urandom(32)` key, writes `<pack_id>.enc`, `<pack_id>.key` (hex, mode 0600) and `<pack_id>.json` (`{"pack_id", "channel", "model", "sha256", "size", "file", "key_file"}`), prints the JSON. Default `pack_id` is `f"{channel}-qwen3-{tts_model_type}-{tts_model_size}-{mode}-{YYYYMMDDTHHMMSSZ}"`.
  - `inspect FILE`: prints the public header plus `sha256` and `size`.
  - `keygen`: prints `{"signing_seed_b64url", "signing_public_b64url", "key_id"}`.
  - `grant --signing-seed B64URL --pack FILE --key FILE --helper-public-key B64URL --channel NAME --model-id ID --pack-url URL`: prints the grant message JSON (model identity taken from the pack's public header, which must match `--model-id`).
  - `fixtures OUT`: `voicepack.write_fixtures(OUT)`.
  - `native/pack.mjs build|inspect ... --config voice-config.json`: validates the config with `config.mjs`, spawns `pack.py` with the config's `python` and the validated config on stdin, forwards the remaining arguments and exit code.

- [ ] **Step 1: Write the failing tests (no model needed)**

```python
# tests/test_pack_cli.py
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
            with self.assertRaises(subprocess.CalledProcessError):
                run('grant', '--signing-seed', keys['signing_seed_b64url'], '--pack', str(enc), '--key', str(key), '--helper-public-key', FIX['helper_public_b64url'],
                    '--channel', 'hexxyi', '--model-id', 'qwen3_tts-base-other-12hz', '--pack-url', 'https://x/p')
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `PYTHON=$PYTHON npm run test:python`
Expected: FAIL with `FileNotFoundError` for `native/pack.py`

- [ ] **Step 3: Implement `native/pack.py` and `native/pack.mjs`**

`build` imports `worker` lazily (it loads a model); the other subcommands import only `voicepack`. Write the key file with `os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)`.

- [ ] **Step 4: Run the tests to verify they pass, then build a real pack**

Run: `PYTHON=$PYTHON npm run test:python` → PASS.
Run: `node native/pack.mjs build --config voice-config.json --reference <wav> --transcript <txt> --reference-language ru --mode icl --channel hexxyi --label hexxyi --consent-ref <ref> --out /tmp/packs` and the same with `--mode embedding`.
Expected: two `.enc`/`.key`/`.json` triples; `node native/pack.mjs inspect /tmp/packs/<id>.enc` prints matching headers; no plaintext file anywhere in `/tmp/packs`.

- [ ] **Step 5: Commit**

```bash
git add native/pack.py native/pack.mjs tests/test_pack_cli.py
git commit -m "feat(pack): owner pack builder, inspect, keygen and development grants"
```

---

### Task 11: Page adapter: identity, load, generate-only and transparent reload

**Files:**
- Modify: `page/local-voice.js`
- Modify: `tests/voice-browser.mjs`

**Interfaces:**
- Consumes: `packParts`, `ERRORS` from Task 5; bridge replies from Task 7.
- Produces, on `LocalVoice`:
  - Constructor options `playback = true` and `obtainVoice = null` (async `identity => ({grant, signature, pack})`, `pack` an `ArrayBuffer` or `Uint8Array`). With `playback: false` no `AudioContext` or `VoicePlayback` is created, `start()` does not call `context.resume()`, and `speak()` resolves `{samples: Float32Array, info}`.
  - `async identity() -> {voice, model, model_id, public_key?}` via `call('voice_identity')`.
  - `async loadVoice({grant, signature, pack}) -> {loaded, pack_id, mode}`: SHA-256 via `crypto.subtle.digest`, one `voice_load` call (id resolves at the end, 180 s timeout) followed by sequential `voice_part` calls; emits `onState({state: 'voice', loaded: true, pack_id, mode})`.
  - `start()`: after warmup, when `obtainVoice` is set, calls `identity()`; if `voice !== 'pack'` emits `onState({state: 'voice', loaded: false, reason: 'not_pack', voice})` and returns; otherwise `loadVoice(await obtainVoice(identity))`. If that load fails with `ERRORS.voice`, it fetches a fresh identity and tries once more before rejecting.
  - `speak()`: on `ERRORS.no_voice` with `obtainVoice` set, performs identity → obtainVoice → loadVoice once and retries the speak once; a second `no_voice` rejects.

- [ ] **Step 1: Extend the browser test's simulated helper and assertions**

In `addInitScript`, extend `postMessage` handling: `voice_identity` replies `{id, value: {voice: 'pack', model: {}, model_id: 'qwen3_tts-base-test-12hz', public_key: window.helperKey}}` where `window.helperKey` starts as `'A'.repeat(43)`; `voice_load` records `window.load = m` and replies nothing; `voice_part` replies `{id, value: {index}}` and, on the last part, replies to the load id with `{value: {loaded: true, pack_id: 'p', mode: 'icl'}}` unless `window.failLoadOnce` is set, in which case it replies `{error: 'voice'}` once and sets `window.helperKey = 'B'.repeat(43)`; `speak` replies `{error: 'no_voice'}` the first time `window.loseVoice` is true, then clears it and behaves as before.

Add to the page evaluation a second scenario:

```js
const obtained = [];
const quiet = new LocalVoice({playback: false, onState: s => window.states.push(s), obtainVoice: async identity => { obtained.push(identity.public_key); return {grant: {v: 'voice_grant_v1'}, signature: 'A'.repeat(86), pack: new Uint8Array(20000).fill(3)}; }});
window.failLoadOnce = true;
await quiet.start();
window.loseVoice = true;
const generated = await quiet.speak({session: 'browser', utterance_id: '9', text: 'Again.', language: 'en', t_start: 1, t_end: 2, prosody: null});
result.reloaded = obtained;               // expect ['AAAA…', 'BBBB…', 'BBBB…']
result.partCount = window.forwarded.filter(m => m.type === 'voice_part').length;   // 2 per load × 3 loads = 6
result.generatedSamples = generated.samples.length;   // 2400
result.loadSize = window.load.size;        // 20000
await quiet.close();
```

Assert: `assert.deepEqual(states.reloaded, ['A'.repeat(43), 'B'.repeat(43), 'B'.repeat(43)])`, `assert.equal(states.partCount, 6)`, `assert.equal(states.generatedSamples, 2400)`, `assert.equal(states.loadSize, 20000)`, and that `states.states` contains `{state: 'voice', loaded: true, pack_id: 'p', mode: 'icl'}`.

- [ ] **Step 2: Build and run the browser test to verify it fails**

Run: `npm run build && npm run test:browser`
Expected: FAIL (`quiet.start` rejects or `obtainVoice` never called)

- [ ] **Step 3: Implement in `page/local-voice.js`**

Keep the existing `call()`; `loadVoice` sends the parts after the load declaration without awaiting the load promise in between, awaiting each part's acknowledgement.

- [ ] **Step 4: Build and run all tests to verify they pass**

Run: `npm test && npm run build && npm run test:browser`
Expected: PASS, browser output includes the existing "Browser checks passed" line.

- [ ] **Step 5: Commit**

```bash
git add page/local-voice.js tests/voice-browser.mjs
git commit -m "feat(page): voice identity, chunked load, generate-only mode and reload"
```

---

### Task 12: Smoke with a development grant, and documentation

**Files:**
- Modify: `native/smoke.mjs`, `README.md`, `docs/local-voice.md`, `extension/settings.html`

**Interfaces:**
- Produces: `node native/smoke.mjs CONFIG OUTPUT_WAV [--pack FILE --key FILE]`. With `--pack`, smoke runs `pack.py keygen`, overrides the loaded config with `voice: 'pack', voicePublicKeys: [<throwaway public>]` and no reference fields, warms up, reads the identity, runs `pack.py grant` with the helper's public key and `--pack-url https://smoke.invalid/pack`, feeds `voice_load` plus `voice_part`s to the service (using `packParts` and `node:crypto` SHA-256), waits for `{loaded: true}`, then speaks the smoke phrase as today and writes the WAV.

- [ ] **Step 1: Implement the smoke path**

Reuse the Task 7 request shapes. Print the load result JSON before the speak result.

- [ ] **Step 2: Run it against the real packs from Task 10**

Run: `node native/smoke.mjs voice-config.json /tmp/streamir-icl.wav --pack /tmp/packs/<icl>.enc --key /tmp/packs/<icl>.key` and the same for the `embedding` pack, then `node native/smoke.mjs voice-config.json /tmp/streamir-ref.wav` with the reference-mode config.
Expected: three WAVs; the ICL pack render and the reference render have the same duration within 0.5 s and sound like the same voice; the owner listens to both pack renders and records the choice.

- [ ] **Step 3: Verify nothing was written**

Run: `find ~/.config/streamir-qwen /tmp/packs -newer /tmp/packs/<icl>.json -type f` and `ls -la /tmp/packs`
Expected: only the three files per pack and the WAVs; no plaintext, no key copies.

- [ ] **Step 4: Update the documentation**

- `README.md`: a "Streamer voice pack" section with the pack-mode `voice-config.json` (`"voice": "pack", "voicePublicKeys": ["<production key, published at GET /voice/public-key>"]`), the recommended 1.7B Base 4-bit install in pack mode, the `node native/pack.mjs build …` command, the smoke `--pack` command, `PYTHON=… npm run test:python`, and a threat-model paragraph using the words "not stored on your computer" and never "cannot be copied". Record the real-model smoke results with date, as the 21 October note does.
- `docs/local-voice.md`: the new bridge messages (`voice_identity`, `voice_load`, `voice_part`), the part bounds, the `no_voice` and `voice` errors, `status.voice`, the adapter options `playback` and `obtainVoice`, the reload behaviour, and the statement that a worker restart requires a new grant.
- `extension/settings.html` step 1: mention that the streamer's voice arrives from Streamir as an encrypted pack when the viewer enables it on the page, and is not stored on the computer.

- [ ] **Step 5: Run everything and commit**

Run: `npm test && PYTHON=$PYTHON npm run test:python && npm run build && npm run test:browser`
Expected: all PASS.

```bash
git add native/smoke.mjs README.md docs/local-voice.md extension/settings.html
git commit -m "feat(smoke): render through a development grant; document pack mode"
```

---

## Handoff to the other repositories

After Task 12 the server plan can vendor `native/voicepack.py` with a SHA-256 pin (the server already does this for Studio's `runtime_contract.py`) and verify `tests/fixtures/voice_grant_v1.json`; its `issue_grant` call is the one defined in Task 4. The website plan consumes `dist/viewer-local-voice.js` with the Task 11 options. Both plans are written separately in their repositories.
