# tests/test_parity.py — runs only with STREAMIR_VOICE_CONFIG=<voice-config.json with a reference voice> and STREAMIR_REFERENCE=<wav> STREAMIR_REFERENCE_TEXT=<text>
import base64, json, os, sys, time, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]; sys.path.insert(0, str(ROOT / 'native'))
CONFIG = os.environ.get('STREAMIR_VOICE_CONFIG')
PHRASE = 'Thank you all for being here tonight.'

@unittest.skipUnless(CONFIG, 'real model parity is opt-in')
class ParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from worker import Engine
        cls.config = json.loads(Path(CONFIG).read_text()); cls.config.update(voice='pack', voicePublicKeys=['A' * 43])
        cls.config.pop('referenceAudio', None); cls.config.pop('referenceText', None)
        cls.engine = Engine(cls.config)  # One model load shared by both tests.
        cls.ref, cls.text = os.environ['STREAMIR_REFERENCE'], os.environ['STREAMIR_REFERENCE_TEXT']

    def pack(self, mode):
        import voicepack as vp
        text = self.text if mode == 'icl' else None
        emb, codes, frames = self.engine.conditioning(self.ref, text, mode)
        identity = self.engine.pack_voice.identity
        plaintext = vp.build_pack(pack_id=f'parity-{mode}', channel='test', label='t', consent_ref='t', model=identity, mode=mode, reference_language='ru',
                                  ref_text=text, spk_embedding=emb, ref_codes=codes, builder={'backend': self.config['backend'], 'package': 'test', 'model_sha256': '0' * 64}, built='2026-10-22T00:00:00Z')
        return vp.parse_pack(plaintext, identity), emb, codes, frames

    def test_pack_conditioning_matches_audio_path(self):
        import numpy as np
        pack, emb, codes, frames = self.pack('icl')
        self.engine.apply(pack)
        if self.config['backend'] == 'mlx':
            from mlx_audio.utils import load_audio
            audio = load_audio(self.ref, sample_rate=24000)
            direct = self.engine.model.__class__.extract_speaker_embedding(self.engine.model, audio)
            self.assertTrue(np.allclose(np.array(direct[0]), np.frombuffer(emb, '<f4'), atol=1e-5))
            self.assertTrue(np.array_equal(np.array(self.engine.mlx_voice['codes'][0]).T, np.frombuffer(codes, '<i4').reshape(frames, -1)))
        else:
            item = self.engine.model.create_voice_clone_prompt(ref_audio=self.ref, ref_text=self.text)[0]
            self.assertTrue(np.allclose(item.ref_spk_embedding.float().cpu().numpy(), np.frombuffer(emb, '<f4'), atol=1e-5))
            self.assertTrue(np.array_equal(item.ref_code.cpu().numpy().reshape(frames, -1), np.frombuffer(codes, '<i4').reshape(frames, -1)))

    def render(self, label, ref_text=False):
        """Seeded Engine.synthesize PCM. With `ref_text` (a string, or None for x-vector only) it renders from the real
        reference audio through mlx-audio's class methods, as reference mode does; otherwise from the applied pack."""
        import mlx.core as mx, numpy as np
        from mlx_audio.utils import load_audio
        engine, model, saved = self.engine, self.engine.model, self.engine.pack_voice
        if ref_text is not False:
            # Drop the instance overrides an applied pack installs, so generation reads the reference audio.
            vars(model).pop('extract_speaker_embedding', None); vars(model.speech_tokenizer).pop('encode', None)
            model._icl_cache.clear()
            engine.pack_voice, engine.voice = None, True
            engine.reference_audio, engine.config['referenceText'] = load_audio(self.ref, sample_rate=24000), ref_text
        parts, started = [], time.monotonic()
        job = {'session': 'parity', 'utterance_id': label, 'text': PHRASE, 'language': 'en', 't_start': 0, 't_end': 2, 'prosody': None}
        try:
            mx.random.seed(0)
            engine.synthesize(job, lambda m: parts.append(np.frombuffer(base64.b64decode(m['data']), '<i2')))
        finally:
            engine.pack_voice, engine.reference_audio = saved, None; engine.config.pop('referenceText', None)
        print(f'{label}: {time.monotonic() - started:.2f} s', file=sys.stderr)
        return np.concatenate(parts)

    def same(self, a, b):
        # Exact: with mx.random.seed(0) before each generate, MLX on Metal rendered bit-identical int16 PCM for the
        # pack and audio paths (22 October 2026, 1.7B Base 4-bit). Loosen only with a measured reason.
        import numpy as np
        self.assertTrue(np.array_equal(a, b))

    def test_seeded_pack_render_matches_audio_render(self):
        if self.config['backend'] != 'mlx':
            self.skipTest('seeded render parity is qualified on MLX only')
        icl, embedding = self.pack('icl')[0], self.pack('embedding')[0]
        from_audio, from_xvector = self.render('audio-icl', self.text), self.render('audio-xvector', None)
        import numpy as np; self.assertFalse(np.array_equal(from_audio, from_xvector))  # The comparison discriminates voices.
        self.engine.apply(icl); self.same(self.render('pack-icl'), from_audio)
        self.engine.apply(embedding); self.same(self.render('pack-embedding'), from_xvector)
        self.engine.apply(icl); self.same(self.render('pack-icl-again'), from_audio)  # Swapping back restores the first voice.
