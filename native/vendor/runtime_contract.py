"""Shared, dependency-free wire contract. Vendored byte-for-byte by streamir-server."""

import base64
import hashlib
import json
import math
import re
from dataclasses import asdict, dataclass, fields
from pathlib import Path
from typing import Any, cast

CONTRACT_VERSION = "server_intonation_v1"
CONTRACT_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
MAX_SOURCE_SAMPLES = 480_000
MAX_OUTPUT_SECONDS = 60
MAX_TEXT = 8_000
MAX_FRAME_BYTES = 16_000_000
MECHANISMS = ("neutral", "summary_steering", "reference_audio")
STATUSES = ("ok", "unvoiced", "unusable_audio", "timeout", "missing_audio")


class WireError(ValueError):
    pass


def string(value: object, name: str, maximum: int = MAX_TEXT) -> None:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise WireError(f"invalid {name}")


def number(value: object, name: str, low: float = -math.inf, high: float = math.inf) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise WireError(f"invalid {name}")
    try:
        valid = math.isfinite(value) and low <= value <= high
    except OverflowError:
        valid = False
    if not valid:
        raise WireError(f"invalid {name}")


def integer(value: object, name: str, low: int, high: int) -> None:
    if type(value) is not int:
        raise WireError(f"invalid {name}")
    number(value, name, low, high)


def choice(value: object, options: tuple[str, ...], name: str) -> None:
    if not isinstance(value, str) or value not in options:
        raise WireError(f"unsupported {name}")


def sha256(value: object) -> None:
    if not isinstance(value, str) or re.fullmatch("[0-9a-f]{64}", value) is None:
        raise WireError("invalid sha256")


def object_fields(value: object, cls: type[Any]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {f.name for f in fields(cls)}:
        raise WireError(f"invalid {cls.__name__} fields")
    return cast(dict[str, Any], value)


def loads(text: str) -> dict[str, Any]:
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise WireError("duplicate JSON key")
            result[key] = value
        return result

    if len(text.encode()) > MAX_FRAME_BYTES:
        raise WireError("frame too large")
    try:
        value = json.loads(text, object_pairs_hook=pairs)
    except (ValueError, RecursionError) as exc:
        raise WireError("invalid JSON") from exc
    if not isinstance(value, dict):
        raise WireError("expected object")
    return cast(dict[str, Any], value)


def pcm_bytes(data: object, *, maximum: int = MAX_SOURCE_SAMPLES) -> bytes:
    if not isinstance(data, str) or not data or len(data) > 4 * ((maximum * 2 + 2) // 3):
        raise WireError("invalid PCM size")
    try:
        result = base64.b64decode(data, validate=True)
    except ValueError as exc:
        raise WireError("invalid PCM base64") from exc
    if not result or len(result) % 2 or len(result) > maximum * 2:
        raise WireError("invalid PCM samples")
    return result


@dataclass(frozen=True)
class Values:
    f0_median_st: float
    f0_iqr_st: float
    energy_dbfs: float
    energy_sd_db: float
    rate: float
    pause_ratio: float
    voicing: float
    duration_s: float

    def __post_init__(self) -> None:
        for f in fields(self):
            number(getattr(self, f.name), f.name)
        for name in ("f0_iqr_st", "energy_sd_db", "rate"):
            number(getattr(self, name), name, 0)
        for name in ("pause_ratio", "voicing"):
            number(getattr(self, name), name, 0, 1)
        number(self.duration_s, "duration", 1 / 16000, 30)


@dataclass(frozen=True)
class Summary:
    version: str
    implementation: str
    values: Values

    def __post_init__(self) -> None:
        choice(self.version, ("prosody_v1",), "descriptor version")
        choice(self.implementation, ("studio-python-v1",), "descriptor implementation")
        if not isinstance(self.values, Values):
            raise WireError("invalid descriptor values")


@dataclass(frozen=True)
class Extractor:
    id: str
    revision: str
    config_sha256: str

    def __post_init__(self) -> None:
        choice(self.id, ("studio-python-v1",), "extractor")
        sha256(self.revision)
        sha256(self.config_sha256)


@dataclass(frozen=True)
class Analysis:
    version: str
    session: str
    utterance_id: str
    audio_sha256: str | None
    sample_count: int | None
    source_kind: str
    extractor: Extractor
    status: str
    summary: Summary | None
    contour: None
    audio_ref: str | None
    analysis_ms: float

    def __post_init__(self) -> None:
        choice(self.version, ("source_prosody_v1",), "analysis version")
        string(self.session, "session", 200)
        string(self.utterance_id, "utterance ID", 200)
        choice(self.source_kind, ("clean_mic", "stream_mix"), "source kind")
        choice(self.status, STATUSES, "analysis status")
        if not isinstance(self.extractor, Extractor) or self.contour is not None:
            raise WireError("unsupported extractor or contour")
        number(self.analysis_ms, "analysis time", 0)
        if self.audio_ref is not None:
            string(self.audio_ref, "audio handle", 100)
        if self.status == "missing_audio":
            if any(
                v is not None for v in (self.audio_sha256, self.sample_count, self.summary, self.audio_ref)
            ):
                raise WireError("missing audio cannot carry measurements")
        else:
            sha256(self.audio_sha256)
            integer(self.sample_count, "sample count", 1, MAX_SOURCE_SAMPLES)
        if self.status in ("ok", "unvoiced"):
            if not isinstance(self.summary, Summary) or self.sample_count is None:
                raise WireError("analysis requires descriptors")
            if abs(self.summary.values.duration_s - self.sample_count / 16000) > 0.000001:
                raise WireError("descriptor duration does not match PCM")
            if (self.summary.values.voicing >= 0.1) != (self.status == "ok"):
                raise WireError("analysis status disagrees with voicing")
        elif self.summary is not None:
            raise WireError("failed analysis cannot carry descriptors")

    @classmethod
    def parse(cls, value: object) -> "Analysis":
        obj = dict(object_fields(value, cls))
        obj["extractor"] = Extractor(**object_fields(obj["extractor"], Extractor))
        if obj["summary"] is not None:
            summary = dict(object_fields(obj["summary"], Summary))
            summary["values"] = Values(**object_fields(summary["values"], Values))
            obj["summary"] = Summary(**summary)
        return cls(**obj)


@dataclass(frozen=True)
class Speak:
    version: str
    session: str
    id: str
    pack_sha256: str
    text: str
    language: str
    source_text: str
    source_language: str
    prosody: Analysis
    target_duration_s: float | None
    mechanism: str
    fallback: str

    def __post_init__(self) -> None:
        choice(self.version, ("speak_v3",), "speak version")
        string(self.session, "session", 200)
        string(self.id, "utterance ID", 200)
        sha256(self.pack_sha256)
        string(self.text, "translated text")
        string(self.source_text, "source text")
        choice(self.language, ("en",), "output language")
        choice(self.source_language, ("ru",), "source language")
        choice(self.mechanism, MECHANISMS, "mechanism")
        choice(self.fallback, ("neutral", "summary_steering", "reject"), "fallback")
        if not isinstance(self.prosody, Analysis):
            raise WireError("invalid analysis")
        if (self.session, self.id) != (self.prosody.session, self.prosody.utterance_id):
            raise WireError("analysis identity mismatch")
        if self.target_duration_s is not None:
            number(self.target_duration_s, "target duration", 1 / 16000, 30)

    @classmethod
    def parse(cls, value: object) -> "Speak":
        obj = dict(object_fields(value, cls))
        obj["prosody"] = Analysis.parse(obj["prosody"])
        return cls(**obj)


@dataclass(frozen=True)
class Controls:
    tempo: float
    pitch_semitones: float
    gain_db: float
    style: str | None
    energy_baseline_ready: bool

    def __post_init__(self) -> None:
        number(self.tempo, "tempo", 0.75, 1.6)
        number(self.pitch_semitones, "pitch", -2, 3)
        number(self.gain_db, "gain", -6, 6)
        if self.style is not None:
            string(self.style, "style", 100)
        if type(self.energy_baseline_ready) is not bool:
            raise WireError("invalid energy baseline status")


@dataclass(frozen=True)
class Spoken:
    version: str
    session: str
    id: str
    pack_sha256: str
    requested_mechanism: str
    applied_mechanism: str
    fallback_reason: str | None
    applied_controls: Controls
    ignored_controls: tuple[str, ...]
    predicted_fit: str | None
    actual_duration_s: float
    actual_duration_error_s: float | None
    first_audio_ms: float
    latency_mode: str
    sample_rate: int
    pcm16: str

    def __post_init__(self) -> None:
        choice(self.version, ("speak_result_v3",), "result version")
        string(self.session, "session", 200)
        string(self.id, "utterance ID", 200)
        sha256(self.pack_sha256)
        choice(self.requested_mechanism, MECHANISMS, "requested mechanism")
        choice(self.applied_mechanism, MECHANISMS, "applied mechanism")
        if self.fallback_reason is not None:
            string(self.fallback_reason, "fallback reason", 100)
        if self.requested_mechanism != self.applied_mechanism and self.fallback_reason is None:
            raise WireError("fallback must be reported")
        if not isinstance(self.applied_controls, Controls):
            raise WireError("invalid controls")
        if not isinstance(self.ignored_controls, tuple):
            raise WireError("invalid ignored controls")
        for value in self.ignored_controls:
            string(value, "ignored control", 100)
        if self.predicted_fit is not None:
            choice(self.predicted_fit, ("ok", "over", "under"), "predicted fit")
        number(self.actual_duration_s, "output duration", 1 / 48000, MAX_OUTPUT_SECONDS)
        if self.actual_duration_error_s is not None:
            number(self.actual_duration_error_s, "duration error", -30, MAX_OUTPUT_SECONDS)
        number(self.first_audio_ms, "first audio", 0)
        choice(self.latency_mode, ("buffered",), "latency mode")
        integer(self.sample_rate, "sample rate", 8000, 48000)
        pcm = pcm_bytes(self.pcm16, maximum=self.sample_rate * MAX_OUTPUT_SECONDS)
        if abs(len(pcm) / (2 * self.sample_rate) - self.actual_duration_s) > 1 / self.sample_rate:
            raise WireError("output duration disagrees with PCM")

    @classmethod
    def parse(cls, value: object) -> "Spoken":
        obj = dict(object_fields(value, cls))
        obj["applied_controls"] = Controls(**object_fields(obj["applied_controls"], Controls))
        if not isinstance(obj["ignored_controls"], list):
            raise WireError("invalid ignored controls")
        obj["ignored_controls"] = tuple(obj["ignored_controls"])
        return cls(**obj)


def dumps(value: Analysis | Speak | Spoken) -> str:
    return json.dumps(asdict(value), allow_nan=False, separators=(",", ":"))
