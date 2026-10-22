import path from 'node:path';
export function config(value) {
  if (!value || !path.isAbsolute(value.python ?? '') || !path.isAbsolute(value.modelPath ?? '') ||
      !['mlx', 'torch'].includes(value.backend) || !['auto', 'cuda', 'cpu', 'metal'].includes(value.device) ||
      (value.backend === 'mlx' && !['auto', 'metal'].includes(value.device)) ||
      (value.backend === 'torch' && value.device === 'metal') ||
      !['custom_voice', 'base'].includes(value.mode) ||
      (value.mode === 'custom_voice' && !/^[a-zA-Z_]{1,40}$/.test(value.speaker ?? '')) ||
      (value.mode === 'base' && (!path.isAbsolute(value.referenceAudio ?? '') || typeof value.referenceText !== 'string' ||
        !value.referenceText.trim() || value.referenceText.length > 1000))) throw new Error('Invalid local voice configuration');
  return {
    python: value.python, modelPath: value.modelPath, backend: value.backend, device: value.device, mode: value.mode,
    ...(value.mode === 'custom_voice' ? {speaker: value.speaker} : {referenceAudio: value.referenceAudio, referenceText: value.referenceText}),
  };
}
