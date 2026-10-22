"""Encrypted voice pack primitives.

The server vendors this module byte-for-byte, so it must import only the
Python standard library and `cryptography`.
"""
import base64
import hashlib
import json
import re
from dataclasses import dataclass

_B64URL = re.compile(r'[A-Za-z0-9_-]*')
_TOKEN = re.compile(r'[a-z0-9_]{1,16}')


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
