const CLIENT_VERSION_PATTERN = /^\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?$/;
const MAX_CLIENT_VERSION_PART = 2_147_483_647;

interface ParsedClientVersion {
  parts: number[];
  prerelease: string | null;
}

const parseClientVersion = (value: string): ParsedClientVersion | null => {
  const normalized = value.trim();
  if (!CLIENT_VERSION_PATTERN.test(normalized)) return null;
  const prereleaseSeparator = normalized.indexOf('-');
  const release = prereleaseSeparator >= 0
    ? normalized.slice(0, prereleaseSeparator)
    : normalized;
  const prerelease = prereleaseSeparator >= 0
    ? normalized.slice(prereleaseSeparator + 1)
    : null;
  const parts = release.split('.').map(Number);
  if (parts.some(part => (
    !Number.isSafeInteger(part) || part > MAX_CLIENT_VERSION_PART
  ))) return null;
  return { parts, prerelease };
};

export const isClientVersionAtLeast = (
  currentVersion: string | null | undefined,
  minimumVersion: string | null | undefined,
): boolean => {
  if (!currentVersion || !minimumVersion) return false;
  const current = parseClientVersion(currentVersion);
  const minimum = parseClientVersion(minimumVersion);
  if (!current || !minimum) return false;

  const length = Math.max(current.parts.length, minimum.parts.length);
  for (let index = 0; index < length; index += 1) {
    const currentPart = current.parts[index] ?? 0;
    const minimumPart = minimum.parts[index] ?? 0;
    if (currentPart !== minimumPart) return currentPart > minimumPart;
  }
  if (current.prerelease === null && minimum.prerelease !== null) return true;
  if (current.prerelease !== null && minimum.prerelease === null) return false;
  if (current.prerelease === null || minimum.prerelease === null) return true;
  return current.prerelease.toLowerCase() >= minimum.prerelease.toLowerCase();
};
