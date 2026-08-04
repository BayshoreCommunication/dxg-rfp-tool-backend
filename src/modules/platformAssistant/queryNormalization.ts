const COMMON_ASSISTANT_TYPO_REPLACEMENTS: readonly [RegExp, string][] =
  Object.freeze([
    [/\bwher\b/giu, "where"],
    [/\bsetings?\b/giu, "settings"],
  ]);

export const normalizeCommonAssistantTypos = (value: string): string =>
  COMMON_ASSISTANT_TYPO_REPLACEMENTS.reduce(
    (normalized, [pattern, replacement]) =>
      normalized.replace(pattern, replacement),
    value,
  );
