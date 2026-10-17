// Supported controls are explicit; do not send unknown effort values to other models.
export function reasoningOptions(provider, model) {
  if (provider === 'glm') return /^glm-5\.3(?:-flash)?$/i.test(model ?? '') ? ['low', 'high', 'max'] : [];
  // Claude takes an effort level on every request, and so does a ChatGPT subscription.
  if (provider === 'anthropic' && /^claude-/i.test(model ?? '')) return ['low', 'medium', 'high'];
  if (provider === 'codex') return ['low', 'medium', 'high'];
  return [];
}

export const EFFORT_LABELS = {
  low: 'Low — faster',
  medium: 'Medium — balanced',
  high: 'High — more thinking',
  max: 'Max — deepest thinking',
};
