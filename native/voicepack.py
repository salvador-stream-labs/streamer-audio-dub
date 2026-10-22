"""Encrypted voice pack primitives.

The server vendors this module byte-for-byte, so it must import only the
Python standard library and `cryptography`.
"""
import base64
import hashlib
import json
import re
import struct
from dataclasses import dataclass

_B64URL = re.compile(r'[A-Za-z0-9_-]*')
_TOKEN = re.compile(r'[a-z0-9_]{1,16}')

PACK_VERSION = 'voice_pack_v1'
MAX_PLAINTEXT = 1 << 20
MAX_REF_FRAMES = 160
MAX_REF_TEXT = 1000
PACK_ID = r'[a-z0-9][a-z0-9_.-]{0,99}'
_PACK_ID = re.compile(PACK_ID)
_LANGUAGE = re.compile(r'[a-z]{2,3}')


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


def _text(value, high: int, what: str, low: int = 1) -> str:
    if not isinstance(value, str) or not low <= len(value) <= high:
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


def _tensor(spec, dtype: str, shape: list, offset: int, body: bytes) -> bytes:
    length = 4
    for dim in shape:
        length *= dim
    if (not isinstance(spec, dict) or set(spec) != {'dtype', 'shape', 'offset', 'length'} or spec['dtype'] != dtype
            or spec['shape'] != shape or spec['offset'] != offset or spec['length'] != length
            or offset + length > len(body)):
        raise PackError('invalid tensor layout')
    return body[offset:offset + length]


def parse_pack(plaintext: bytes, model: ModelIdentity) -> Pack:
    if not isinstance(plaintext, (bytes, bytearray)) or not 4 <= len(plaintext) <= MAX_PLAINTEXT:
        raise PackError('invalid pack size')
    size = int.from_bytes(plaintext[:4], 'little')
    if size > MAX_PLAINTEXT or 4 + size > len(plaintext):
        raise PackError('invalid header length')
    try:
        header = json.loads(bytes(plaintext[4:4 + size]).decode('utf-8'))
    except ValueError as error:
        raise PackError('invalid header') from error
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
