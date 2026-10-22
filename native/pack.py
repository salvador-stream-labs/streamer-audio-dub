"""Owner tool: build, inspect and grant encrypted voice packs. Run with the helper interpreter and -I."""
import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import voicepack as vp

PLACEHOLDER_KEY = 'A' * 43


def build(args):
    config = json.load(sys.stdin)
    config = {k: v for k, v in config.items() if k not in ('referenceAudio', 'referenceText')}
    config.update(voice='pack', voicePublicKeys=[PLACEHOLDER_KEY])
    transcript = Path(args.transcript).read_text(encoding='utf-8').strip()
    import worker
    engine = worker.Engine(config)
    model = engine.pack_voice.identity
    embedding, codes, _ = engine.conditioning(args.reference, transcript, args.mode)
    now = datetime.now(timezone.utc)
    pack_id = args.pack_id or f'{args.channel}-qwen3-{model.tts_model_type}-{model.tts_model_size}-{args.mode}-{now:%Y%m%d}t{now:%H%M%S}z'
    model_json = Path(config['modelPath'], 'config.json').read_bytes()
    package = 'mlx-audio 0.5.9' if config['backend'] == 'mlx' else 'qwen-tts 0.1.1'
    plaintext = vp.build_pack(pack_id=pack_id, channel=args.channel, label=args.label, consent_ref=args.consent_ref, model=model,
                              mode=args.mode, reference_language=args.reference_language,
                              ref_text=transcript if args.mode == 'icl' else None, spk_embedding=embedding, ref_codes=codes,
                              builder={'backend': config['backend'], 'package': package, 'model_sha256': hashlib.sha256(model_json).hexdigest()},
                              built=now.strftime('%Y-%m-%dT%H:%M:%SZ'))
    key = os.urandom(32)
    ciphertext = vp.encrypt_pack(plaintext, key)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    summary = {'pack_id': pack_id, 'channel': args.channel, 'model': model.id, 'sha256': hashlib.sha256(ciphertext).hexdigest(),
               'size': len(ciphertext), 'file': f'{pack_id}.enc', 'key_file': f'{pack_id}.key'}
    for name, data, mode in ((summary['file'], ciphertext, 0o644), (summary['key_file'], key.hex().encode(), 0o600),
                             (f'{pack_id}.json', json.dumps(summary).encode(), 0o644)):
        fd = os.open(out / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
    print(json.dumps(summary))


def inspect(args):
    data = Path(args.file).read_bytes()
    print(json.dumps({**vp.public_header(data), 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}))


def keygen(_):
    seed = os.urandom(32)
    public = vp.signing_public_key(seed)
    print(json.dumps({'signing_seed_b64url': vp.b64url(seed), 'signing_public_b64url': vp.b64url(public), 'key_id': vp.key_id(public)}))


def grant(args):
    data = Path(args.pack).read_bytes()
    header = vp.public_header(data)
    model = vp.ModelIdentity.parse(header['model'])
    if model.id != args.model_id:
        raise vp.PackError('pack model does not match --model-id')
    print(json.dumps(vp.issue_grant(
        signing_seed=vp.unb64url(args.signing_seed, 32), channel=args.channel, pack_id=header['pack_id'],
        pack_sha256=hashlib.sha256(data).hexdigest(), pack_url=args.pack_url, model=model,
        helper_public_key=vp.unb64url(args.helper_public_key, 32), content_key=bytes.fromhex(Path(args.key).read_text().strip()),
        now=datetime.now(timezone.utc))))


def main():
    parser = argparse.ArgumentParser(prog='pack.py')
    sub = parser.add_subparsers(dest='command', required=True)
    b = sub.add_parser('build')
    b.add_argument('--config-json', required=True, choices=['-'])
    for name in ('reference', 'transcript', 'reference-language', 'channel', 'label', 'consent-ref', 'out'):
        b.add_argument(f'--{name}', required=True)
    b.add_argument('--mode', required=True, choices=['icl', 'embedding'])
    b.add_argument('--pack-id')
    b.set_defaults(run=build)
    i = sub.add_parser('inspect')
    i.add_argument('file')
    i.set_defaults(run=inspect)
    sub.add_parser('keygen').set_defaults(run=keygen)
    g = sub.add_parser('grant')
    for name in ('signing-seed', 'pack', 'key', 'helper-public-key', 'channel', 'model-id', 'pack-url'):
        g.add_argument(f'--{name}', required=True)
    g.set_defaults(run=grant)
    f = sub.add_parser('fixtures')
    f.add_argument('out')
    f.set_defaults(run=lambda a: vp.write_fixtures(a.out))
    args = parser.parse_args()
    try:
        args.run(args)
    except (vp.PackError, ValueError, OSError) as error:
        print(f'pack.py: {type(error).__name__}: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
