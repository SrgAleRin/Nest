export function resolveProfileName(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(trimmed)) {
    throw new Error('NEST_PROFILE must be 1-32 characters: letters, digits, dash or underscore');
  }
  return trimmed;
}
