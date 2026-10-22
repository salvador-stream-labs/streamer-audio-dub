import path from 'node:path';
export function config(value) {
  if (value?.pitchCapSemitones !== undefined && (typeof value.pitchCapSemitones !== 'number' ||
      !Number.isFinite(value.pitchCapSemitones) || value.pitchCapSemitones < 0 || value.pitchCapSemitones > 1)) throw new Error('Invalid pitch cap');
  const pack = value?.mode === 'base' && value.voice === 'pack';
  if (!value || !path.isAbsolute(value.python ?? '') || !path.isAbsolute(value.modelPath ?? '') ||
      !['mlx', 'torch'].includes(value.backend) || !['auto', 'cuda', 'cpu', 'metal'].includes(value.device) ||
      (value.backend === 'mlx' && !['auto', 'metal'].includes(value.device)) ||
      (value.backend === 'torch' && value.device === 'metal') ||
      !['custom_voice', 'base'].includes(value.mode) ||
      (value.mode === 'custom_voice' && !/^[a-zA-Z_]{1,40}$/.test(value.speaker ?? '')) ||
      (value.mode === 'base' && !['reference', 'pack'].includes(value.voice ?? 'reference')) ||
      (value.mode === 'base' && pack && (!Array.isArray(value.voicePublicKeys) || value.voicePublicKeys.length < 1 || value.voicePublicKeys.length > 4 ||
        !value.voicePublicKeys.every(key => /^[A-Za-z0-9_-]{43}$/.test(key)) || value.referenceAudio !== undefined || value.referenceText !== undefined)) ||
      (value.mode === 'base' && !pack && (!path.isAbsolute(value.referenceAudio ?? '') || typeof value.referenceText !== 'string' ||
        !value.referenceText.trim() || value.referenceText.length > 1000))) throw new Error('Invalid local voice configuration');
  return {
    python: value.python, modelPath: value.modelPath, backend: value.backend, device: value.device, mode: value.mode,
    ...(value.pitchCapSemitones === undefined ? {} : {pitchCapSemitones: value.pitchCapSemitones}),
    ...(value.mode === 'custom_voice' ? {speaker: value.speaker} : pack ? {voice: 'pack', voicePublicKeys: value.voicePublicKeys} : {voice: 'reference', referenceAudio: value.referenceAudio, referenceText: value.referenceText}),
  };
}
