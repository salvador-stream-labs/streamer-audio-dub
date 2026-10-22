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
