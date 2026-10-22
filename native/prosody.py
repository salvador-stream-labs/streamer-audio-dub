"""Experimental utterance-wide pitch shift; no contour or duration transfer."""
import math
from fractions import Fraction


def shift_pitch(audio, semitones, sample_rate=24000):
    """Waveform-aligned overlap-add stretch, then resample to original length.

    This operates on a complete bounded utterance, not independent transport
    chunks. Formants are shifted too; speech quality requires listening approval.
    Zero is an exact bypass, including silence and short clips.
    """
    import numpy as np
    from scipy import signal

    if not math.isfinite(semitones) or not 0 <= semitones <= 1:
        raise ValueError('Invalid pitch shift')
    x = np.asarray(audio, dtype=np.float32).reshape(-1)
    if not x.size or not np.isfinite(x).all() or x.size > sample_rate * 45:
        raise ValueError('Invalid audio')
    if semitones == 0:
        return x
    factor = 2 ** (semitones / 12)
    length = max(1, round(x.size * factor))
    hop = max(1, round(sample_rate * .02))
    size, search = 2 * hop, round(sample_rate * .008)
    padded = np.pad(x.astype(np.float64), (hop, size + search))
    window = signal.windows.hann(size, sym=False)
    extended, weight = np.zeros(length + 2*size), np.zeros(length + 2*size)
    previous = 0
    for output in range(0, length + hop, hop):
        nominal = round(output / factor)
        position = nominal
        if output:
            lo, hi = max(0, nominal-search), min(len(padded)-size, nominal+search)
            reference = padded[previous+hop:previous+hop+size]
            if len(reference) == size and float(reference @ reference) > 1e-12:
                candidates = padded[lo:hi+size]
                correlation = signal.correlate(candidates, reference, mode='valid', method='direct')
                squares = np.r_[0., np.cumsum(candidates*candidates)]
                energy = squares[size:] - squares[:-size]
                scores = correlation / np.sqrt(np.maximum(energy, 1e-12))
                # Prefer the scheduled position when several pitch periods match equally well.
                best = np.max(scores)
                close = np.flatnonzero(scores >= best - max(1e-10, abs(best)*1e-5))
                position = lo + int(close[np.argmin(np.abs(lo+close-nominal))])
        frame = padded[position:position+size]
        extended[output:output+size] += frame * window
        weight[output:output+size] += window
        previous = position
    extended = extended[hop:hop+length] / np.maximum(weight[hop:hop+length], 1e-12)
    # Polyphase resampling avoids treating the utterance endpoints as periodic.
    ratio = Fraction(1 / factor).limit_denominator(10000)
    shifted = signal.resample_poly(extended, ratio.numerator, ratio.denominator)
    shifted = np.pad(shifted, (0, max(0, x.size - shifted.size)))[:x.size].astype(np.float32)
    if shifted.size != x.size or not np.isfinite(shifted).all():
        raise ValueError('Invalid shifted audio')
    peak = float(np.max(np.abs(shifted)))
    if peak > 1:
        shifted /= peak
    return shifted
