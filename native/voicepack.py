"""Encrypted voice pack primitives.

The server vendors this module byte-for-byte, so it must import only the
Python standard library and `cryptography`.
"""
import base64
import hashlib
import json
import os
import re
import struct
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

_B64URL = re.compile(r'[A-Za-z0-9_-]*')
_TOKEN = re.compile(r'[a-z0-9_]{1,16}')

PACK_VERSION = 'voice_pack_v1'
MAX_PLAINTEXT = 1 << 20
ENC_VERSION = 'voice_pack_enc_v1'
MAX_CIPHERTEXT = 4 << 20
MAX_PUBLIC_HEADER = 4096
MAX_REF_FRAMES = 160
MAX_REF_TEXT = 1000
PACK_ID = r'[a-z0-9][a-z0-9_.-]{0,99}'
_PACK_ID = re.compile(PACK_ID)
_LANGUAGE = re.compile(r'[a-z]{2,3}')
GRANT_VERSION = 'voice_grant_v1'
GRANT_TTL_S = 600
GRANT_SKEW_S = 60
GRANT_INFO = b'streamir voice_grant_v1'
MAX_PACK_URL = 2048
_SHA256 = re.compile(r'[0-9a-f]{64}')
_TIME = re.compile(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ')


class PackError(ValueError):
    pass


def canonical(value: dict) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode('ascii').rstrip('=')


def unb64url(text: str, length: int | None = None) -> bytes:
    if not isinstance(text, str) or not _B64URL.fullmatch(text) or len(text) % 4 == 1:
        raise PackError('invalid base64url')
    data = base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))
    if b64url(data) != text:
        raise PackError('non-canonical base64url')
    if length is not None and len(data) != length:
        raise PackError(f'expected {length} bytes, got {len(data)}')
    return data


def key_id(public_key: bytes) -> str:
    return hashlib.sha256(public_key).hexdigest()[:16]


def _int_in(value, low: int, high: int) -> bool:
    return type(value) is int and low <= value <= high


@dataclass(frozen=True)
class ModelIdentity:
    family: str
    tts_model_type: str
    tts_model_size: str
    tokenizer: str
    enc_dim: int
    num_code_groups: int

    @classmethod
    def from_config(cls, config: dict) -> 'ModelIdentity':
        try:
            tokenizer_type = config['tokenizer_type']
            if not isinstance(tokenizer_type, str) or not tokenizer_type.endswith('_12hz'):
                raise PackError('unsupported tokenizer_type')
            return cls.parse({'family': 'qwen3_tts', 'tts_model_type': config['tts_model_type'],
                              'tts_model_size': config['tts_model_size'], 'tokenizer': '12hz',
                              'enc_dim': config['speaker_encoder_config']['enc_dim'],
                              'num_code_groups': config['talker_config']['num_code_groups']})
        except (KeyError, TypeError) as error:
            raise PackError('incomplete model config') from error

    @classmethod
    def parse(cls, value: dict) -> 'ModelIdentity':
        keys = {'family', 'tts_model_type', 'tts_model_size', 'tokenizer', 'enc_dim', 'num_code_groups'}
        if not isinstance(value, dict) or set(value) != keys:
            raise PackError('invalid model identity')
        if value['family'] != 'qwen3_tts' or value['tts_model_type'] not in ('base', 'custom_voice'):
            raise PackError('invalid model identity')
        for key in ('tts_model_size', 'tokenizer'):
            if not isinstance(value[key], str) or not _TOKEN.fullmatch(value[key]):
                raise PackError(f'invalid {key}')
        if not _int_in(value['enc_dim'], 1, 8192) or not _int_in(value['num_code_groups'], 1, 64):
            raise PackError('invalid model dimensions')
        return cls(**value)

    def to_dict(self) -> dict:
        return {'family': self.family, 'tts_model_type': self.tts_model_type, 'tts_model_size': self.tts_model_size,
                'tokenizer': self.tokenizer, 'enc_dim': self.enc_dim, 'num_code_groups': self.num_code_groups}

    @property
    def id(self) -> str:
        return f'{self.family}-{self.tts_model_type}-{self.tts_model_size}-{self.tokenizer}'


@dataclass(frozen=True)
class Pack:
    header: dict
    spk_embedding: bytes
    ref_codes: bytes | None

    @property
    def pack_id(self) -> str:
        return self.header['pack_id']

    @property
    def channel(self) -> str:
        return self.header['channel']

    @property
    def mode(self) -> str:
        return self.header['mode']

    @property
    def ref_text(self) -> str | None:
        return self.header.get('ref_text')

    @property
    def model(self) -> ModelIdentity:
        return ModelIdentity.parse(self.header['model'])

    @property
    def frames(self) -> int:
        return self.header['tensors']['ref_codes']['shape'][0] if self.ref_codes is not None else 0


def _units(value: str) -> int:
    return len(value.encode('utf-16-le', 'surrogatepass')) // 2


def _text(value, high: int, what: str, low: int = 1) -> str:
    if not isinstance(value, str) or not low <= _units(value) <= high:
        raise PackError(f'invalid {what}')
    return value


def build_pack(*, pack_id: str, channel: str, label: str, consent_ref: str, model: ModelIdentity, mode: str,
               reference_language: str, ref_text: str | None, spk_embedding: bytes, ref_codes: bytes | None,
               builder: dict, built: str) -> bytes:
    tensors = {'spk_embedding': {'dtype': 'float32', 'shape': [len(spk_embedding) // 4], 'offset': 0,
                                 'length': len(spk_embedding)}}
    body = spk_embedding
    if ref_codes is not None:
        groups = model.num_code_groups
        tensors['ref_codes'] = {'dtype': 'int32', 'shape': [len(ref_codes) // (4 * groups), groups],
                                'offset': len(spk_embedding), 'length': len(ref_codes)}
        body += ref_codes
    header = {'v': PACK_VERSION, 'pack_id': pack_id, 'channel': channel, 'voice': {'label': label, 'consent_ref': consent_ref},
              'model': model.to_dict(), 'mode': mode, 'reference_language': reference_language, 'tensors': tensors,
              'built': built, 'builder': builder}
    if ref_text is not None:
        header['ref_text'] = ref_text
    raw = canonical(header)
    result = len(raw).to_bytes(4, 'little') + raw + body
    parse_pack(result, model)
    return result


def _no_duplicates(pairs: list) -> dict:
    result = dict(pairs)
    if len(result) != len(pairs):
        raise PackError('duplicate header key')
    return result


def _no_constant(name: str):
    raise PackError('invalid header constant')


def _json_header(raw: bytes):
    try:
        return json.loads(bytes(raw).decode('utf-8'), object_pairs_hook=_no_duplicates, parse_constant=_no_constant)
    except (ValueError, RecursionError) as error:
        raise PackError('invalid header') from error


def _tensor(spec, dtype: str, shape: list, offset: int, body: bytes) -> bytes:
    length = 4
    for dim in shape:
        length *= dim
    if not isinstance(spec, dict) or set(spec) != {'dtype', 'shape', 'offset', 'length'}:
        raise PackError('invalid tensor layout')
    if not isinstance(spec['shape'], list) or not all(_int_in(d, 1, MAX_PLAINTEXT) for d in spec['shape']):
        raise PackError('invalid tensor shape')
    if not all(_int_in(spec[k], 0, MAX_PLAINTEXT) for k in ('offset', 'length')):
        raise PackError('invalid tensor layout')
    if (spec['dtype'] != dtype or spec['shape'] != shape or spec['offset'] != offset or spec['length'] != length
            or offset + length > len(body)):
        raise PackError('invalid tensor layout')
    return body[offset:offset + length]


def parse_pack(plaintext: bytes, model: ModelIdentity) -> Pack:
    if not isinstance(plaintext, (bytes, bytearray)) or not 4 <= len(plaintext) <= MAX_PLAINTEXT:
        raise PackError('invalid pack size')
    size = int.from_bytes(plaintext[:4], 'little')
    if size > MAX_PLAINTEXT or 4 + size > len(plaintext):
        raise PackError('invalid header length')
    header = _json_header(plaintext[4:4 + size])
    body = bytes(plaintext[4 + size:])
    keys = {'v', 'pack_id', 'channel', 'voice', 'model', 'mode', 'reference_language', 'tensors', 'built', 'builder'}
    if not isinstance(header, dict) or set(header) - {'ref_text'} != keys or header['v'] != PACK_VERSION:
        raise PackError('invalid header')
    for key in ('pack_id', 'channel'):
        if not isinstance(header[key], str) or not _PACK_ID.fullmatch(header[key]):
            raise PackError(f'invalid {key}')
    voice = header['voice']
    if not isinstance(voice, dict) or set(voice) != {'label', 'consent_ref'}:
        raise PackError('invalid voice')
    _text(voice['label'], 60, 'label'); _text(voice['consent_ref'], 200, 'consent_ref')
    if ModelIdentity.parse(header['model']) != model:
        raise PackError('model mismatch')
    if not isinstance(header['reference_language'], str) or not _LANGUAGE.fullmatch(header['reference_language']):
        raise PackError('invalid reference_language')
    _text(header['built'], 40, 'built')
    builder = header['builder']
    if (not isinstance(builder, dict) or len(builder) > 16
            or any(not isinstance(k, str) or len(k) > 64 or not isinstance(v, str) or len(v) > 200 for k, v in builder.items())):
        raise PackError('invalid builder')
    mode, tensors = header['mode'], header['tensors']
    if mode not in ('icl', 'embedding') or not isinstance(tensors, dict) or ('ref_text' in header) != (mode == 'icl') \
            or set(tensors) != ({'spk_embedding', 'ref_codes'} if mode == 'icl' else {'spk_embedding'}):
        raise PackError('invalid mode')
    embedding = _tensor(tensors['spk_embedding'], 'float32', [model.enc_dim], 0, body)
    ref_codes = None
    end = len(embedding)
    if mode == 'icl':
        _text(header['ref_text'], MAX_REF_TEXT, 'ref_text')
        spec = tensors['ref_codes']
        shape = spec.get('shape') if isinstance(spec, dict) else None
        if not isinstance(shape, list) or len(shape) != 2 or not _int_in(shape[0], 1, MAX_REF_FRAMES) \
                or shape[1] != model.num_code_groups:
            raise PackError('invalid ref_codes shape')
        ref_codes = _tensor(spec, 'int32', shape, end, body)
        end += len(ref_codes)
        if any(not 0 <= value <= 65535 for value in struct.unpack(f'<{len(ref_codes) // 4}i', ref_codes)):
            raise PackError('ref_codes out of range')
    if end != len(body):
        raise PackError('trailing tensor data')
    return Pack(header, embedding, ref_codes)


def _public_header(header, raw: bytes) -> dict:
    keys = {'v', 'pack_id', 'channel', 'model', 'cipher', 'size'}
    if not isinstance(header, dict) or set(header) != keys or header['v'] != ENC_VERSION or header['cipher'] != 'aes-256-gcm':
        raise PackError('invalid header')
    for key in ('pack_id', 'channel'):
        if not isinstance(header[key], str) or not _PACK_ID.fullmatch(header[key]):
            raise PackError(f'invalid {key}')
    if ModelIdentity.parse(header['model']).to_dict() != header['model'] or not _int_in(header['size'], 0, MAX_PLAINTEXT):
        raise PackError('invalid header')
    if canonical(header) != raw:
        raise PackError('non-canonical header')
    return header


def _split(ciphertext: bytes) -> tuple[dict, bytes, bytes, bytes]:
    if not isinstance(ciphertext, (bytes, bytearray)) or not 4 <= len(ciphertext) <= MAX_CIPHERTEXT:
        raise PackError('invalid ciphertext size')
    size = int.from_bytes(ciphertext[:4], 'little')
    if size > MAX_PUBLIC_HEADER or 4 + size > len(ciphertext):
        raise PackError('invalid header length')
    raw = bytes(ciphertext[4:4 + size])
    return _public_header(_json_header(raw), raw), raw, bytes(ciphertext[4 + size:16 + size]), bytes(ciphertext[16 + size:])


def public_header(ciphertext: bytes) -> dict:
    return _split(ciphertext)[0]


def _aead(content_key: bytes) -> AESGCM:
    if not isinstance(content_key, (bytes, bytearray)) or len(content_key) != 32:
        raise PackError('content key must be 32 bytes')
    return AESGCM(bytes(content_key))


def encrypt_pack(plaintext: bytes, content_key: bytes, *, nonce: bytes | None = None) -> bytes:
    aead = _aead(content_key)
    nonce = os.urandom(12) if nonce is None else nonce
    if not isinstance(nonce, bytes) or len(nonce) != 12:
        raise PackError('nonce must be 12 bytes')
    if not isinstance(plaintext, (bytes, bytearray)) or not 4 <= len(plaintext) <= MAX_PLAINTEXT:
        raise PackError('invalid pack size')
    size = int.from_bytes(plaintext[:4], 'little')
    if size > MAX_PLAINTEXT or 4 + size > len(plaintext):
        raise PackError('invalid header length')
    inner = _json_header(plaintext[4:4 + size])
    if not isinstance(inner, dict) or not all(k in inner for k in ('pack_id', 'channel', 'model')):
        raise PackError('invalid header')
    header = {'v': ENC_VERSION, 'pack_id': inner['pack_id'], 'channel': inner['channel'], 'model': inner['model'],
              'cipher': 'aes-256-gcm', 'size': len(plaintext)}
    raw = canonical(header)
    _public_header(header, raw)
    return len(raw).to_bytes(4, 'little') + raw + nonce + aead.encrypt(nonce, bytes(plaintext), raw)


def decrypt_pack(ciphertext: bytes, content_key: bytes) -> bytes:
    aead = _aead(content_key)
    header, raw, nonce, sealed = _split(ciphertext)
    if len(nonce) != 12:
        raise PackError('truncated ciphertext')
    try:
        plaintext = aead.decrypt(nonce, sealed, raw)
    except InvalidTag as error:
        raise PackError('decryption failed') from error
    if len(plaintext) != header['size']:
        raise PackError('size mismatch')
    return plaintext


def signing_public_key(seed: bytes) -> bytes:
    return Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes_raw()


def _stamp(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _moment(text) -> datetime:
    if not isinstance(text, str) or not _TIME.fullmatch(text):
        raise PackError('invalid timestamp')
    try:
        return datetime.strptime(text, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
    except ValueError as error:
        raise PackError('invalid timestamp') from error


def _kek(private: X25519PrivateKey, peer: bytes) -> bytearray:
    shared = bytearray(private.exchange(X25519PublicKey.from_public_bytes(peer)))
    try:
        return bytearray(HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=GRANT_INFO).derive(bytes(shared)))
    finally:
        shared[:] = bytes(len(shared))


def _wrap_aad(grant: dict) -> bytes:
    return canonical({k: v for k, v in grant.items() if k != 'wrap'})


def issue_grant(*, signing_seed: bytes, channel: str, pack_id: str, pack_sha256: str, pack_url: str, model: ModelIdentity,
                helper_public_key: bytes, content_key: bytes, now: datetime, ttl_s: int = GRANT_TTL_S,
                server_private: bytes | None = None, nonce: bytes | None = None) -> dict:
    signer = Ed25519PrivateKey.from_private_bytes(signing_seed)
    ephemeral = X25519PrivateKey.generate() if server_private is None else X25519PrivateKey.from_private_bytes(server_private)
    nonce = os.urandom(12) if nonce is None else nonce
    if not isinstance(nonce, bytes) or len(nonce) != 12 or not isinstance(content_key, bytes) or len(content_key) != 32:
        raise PackError('invalid wrap input')
    kek = _kek(ephemeral, helper_public_key)
    grant = {'v': GRANT_VERSION, 'channel': channel, 'pack_id': pack_id, 'pack_sha256': pack_sha256, 'pack_url': pack_url,
             'model': model.to_dict(), 'key_id': key_id(signer.public_key().public_bytes_raw()),
             'helper_public_key': b64url(helper_public_key), 'server_public_key': b64url(ephemeral.public_key().public_bytes_raw()),
             'issued': _stamp(now), 'expires': _stamp(now + timedelta(seconds=ttl_s))}
    try:
        grant['wrap'] = {'nonce': b64url(nonce), 'data': b64url(AESGCM(bytes(kek)).encrypt(nonce, content_key, _wrap_aad(grant)))}
    finally:
        kek[:] = bytes(len(kek))
    return {'v': GRANT_VERSION, 'grant': grant, 'signature': b64url(signer.sign(canonical(grant)))}


def _grant_shape(message) -> tuple[dict, bytes]:
    if not isinstance(message, dict) or set(message) != {'v', 'grant', 'signature'} or message['v'] != GRANT_VERSION:
        raise PackError('invalid grant message')
    grant = message['grant']
    keys = {'v', 'channel', 'pack_id', 'pack_sha256', 'pack_url', 'model', 'key_id', 'helper_public_key', 'server_public_key',
            'issued', 'expires', 'wrap'}
    if not isinstance(grant, dict) or set(grant) != keys or grant['v'] != GRANT_VERSION:
        raise PackError('invalid grant')
    for key in ('channel', 'pack_id'):
        if not isinstance(grant[key], str) or not _PACK_ID.fullmatch(grant[key]):
            raise PackError(f'invalid {key}')
    if not isinstance(grant['pack_sha256'], str) or not _SHA256.fullmatch(grant['pack_sha256']):
        raise PackError('invalid pack_sha256')
    if not isinstance(grant['pack_url'], str) or not 1 <= len(grant['pack_url']) <= MAX_PACK_URL:
        raise PackError('invalid pack_url')
    if ModelIdentity.parse(grant['model']).to_dict() != grant['model']:
        raise PackError('invalid model identity')
    if not isinstance(grant['key_id'], str) or not re.fullmatch(r'[0-9a-f]{16}', grant['key_id']):
        raise PackError('invalid key_id')
    for key in ('helper_public_key', 'server_public_key'):
        unb64url(grant[key], 32)
    _moment(grant['issued']); _moment(grant['expires'])
    wrap = grant['wrap']
    if not isinstance(wrap, dict) or set(wrap) != {'nonce', 'data'}:
        raise PackError('invalid wrap')
    unb64url(wrap['nonce'], 12); unb64url(wrap['data'], 48)
    return grant, unb64url(message['signature'], 64)


def _verify(message: dict, pinned_keys, helper_private: X25519PrivateKey, model: ModelIdentity, ciphertext: bytes,
            now: datetime) -> bytearray:
    grant, signature = _grant_shape(message)
    matches = [key for key in pinned_keys if isinstance(key, bytes) and len(key) == 32 and key_id(key) == grant['key_id']]
    if not matches:
        raise PackError('unknown signing key')
    try:
        Ed25519PublicKey.from_public_bytes(matches[0]).verify(signature, canonical(grant))
    except InvalidSignature as error:
        raise PackError('bad signature') from error
    if _moment(grant['issued']) > now + timedelta(seconds=GRANT_SKEW_S):
        raise PackError('grant issued in the future')
    if _moment(grant['expires']) <= now:
        raise PackError('grant expired')
    helper_public = helper_private.public_key().public_bytes_raw()
    if unb64url(grant['helper_public_key'], 32) != helper_public:
        raise PackError('grant is for another helper')
    if ModelIdentity.parse(grant['model']) != model:
        raise PackError('model mismatch')
    if hashlib.sha256(ciphertext).hexdigest() != grant['pack_sha256']:
        raise PackError('pack digest mismatch')
    header = public_header(ciphertext)
    if (header['channel'], header['pack_id'], header['model']) != (grant['channel'], grant['pack_id'], grant['model']):
        raise PackError('pack header does not match grant')
    kek = _kek(helper_private, unb64url(grant['server_public_key'], 32))
    try:
        wrap = grant['wrap']
        return bytearray(AESGCM(bytes(kek)).decrypt(unb64url(wrap['nonce'], 12), unb64url(wrap['data'], 48), _wrap_aad(grant)))
    except InvalidTag as error:
        raise PackError('key unwrap failed') from error
    finally:
        kek[:] = bytes(len(kek))


def verify_grant(message: dict, *, pinned_keys: list[bytes], helper_private: X25519PrivateKey, model: ModelIdentity,
                 ciphertext: bytes, now: datetime) -> bytes:
    content_key = _verify(message, pinned_keys, helper_private, model, ciphertext, now)
    try:
        return bytes(content_key)
    finally:
        content_key[:] = bytes(len(content_key))


def open_pack(message: dict, *, pinned_keys, helper_private, model, ciphertext, now) -> Pack:
    content_key = _verify(message, pinned_keys, helper_private, model, ciphertext, now)
    plaintext = bytearray()
    try:
        plaintext = bytearray(decrypt_pack(ciphertext, bytes(content_key)))
        return parse_pack(plaintext, model)
    finally:
        content_key[:] = bytes(len(content_key))
        plaintext[:] = bytes(len(plaintext))


def write_fixtures(path: str) -> None:
    model = ModelIdentity.parse({'family': 'qwen3_tts', 'tts_model_type': 'base', 'tts_model_size': 'test', 'tokenizer': '12hz',
                                 'enc_dim': 8, 'num_code_groups': 2})
    helper, seed, content_key = bytes([1]) * 32, bytes([3]) * 32, bytes([4]) * 32
    now = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)
    plaintext = build_pack(pack_id='hexxyi-test-icl-1', channel='hexxyi', label='hexxyi', consent_ref='studio:consent:1',
                           model=model, mode='icl', reference_language='ru', ref_text='\u041f\u0440\u0438\u0432\u0435\u0442',
                           spk_embedding=b'\x00\x00\x80\x3f' * 8, ref_codes=b'\x05\x00\x00\x00' * 6,
                           builder={'backend': 'mlx', 'package': 'mlx-audio 0.5.9', 'model_sha256': '0' * 64},
                           built='2026-10-22T12:00:00Z')
    ciphertext = encrypt_pack(plaintext, bytes([4]) * 32, nonce=bytes([5]) * 12)
    digest = hashlib.sha256(ciphertext).hexdigest()
    helper_public = X25519PrivateKey.from_private_bytes(helper).public_key().public_bytes_raw()
    message = issue_grant(signing_seed=seed, channel='hexxyi', pack_id='hexxyi-test-icl-1', pack_sha256=digest,
                          pack_url='https://server.streamir.app/voice/hexxyi/pack/x', model=model,
                          helper_public_key=helper_public, content_key=content_key, now=now,
                          server_private=bytes([2]) * 32, nonce=bytes([6]) * 12)
    public = signing_public_key(seed)
    vectors = {'model': model.to_dict(), 'plaintext_b64': base64.b64encode(plaintext).decode('ascii'),
               'ciphertext_b64': base64.b64encode(ciphertext).decode('ascii'), 'pack_sha256': digest,
               'helper_private_b64url': b64url(helper), 'helper_public_b64url': b64url(helper_public),
               'signing_seed_b64url': b64url(seed), 'signing_public_b64url': b64url(public), 'key_id': key_id(public),
               'content_key_b64url': b64url(content_key), 'grant_message': message,
               'canonical_grant': canonical(message['grant']).decode('ascii')}
    with open(path, 'w', encoding='utf-8') as out:
        out.write(json.dumps(vectors, indent=2, sort_keys=True) + '\n')
