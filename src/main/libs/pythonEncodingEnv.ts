export const PythonEncodingEnv = {
  Utf8: 'PYTHONUTF8',
  IoEncoding: 'PYTHONIOENCODING',
} as const;
export type PythonEncodingEnv = typeof PythonEncodingEnv[keyof typeof PythonEncodingEnv];

type Environment = Record<string, string | undefined>;

const WINDOWS_PYTHON_ENCODING_DEFAULTS = {
  [PythonEncodingEnv.Utf8]: '1',
  [PythonEncodingEnv.IoEncoding]: 'utf-8',
} as const;

/**
 * Apply Windows Python encoding defaults to a child environment. Only these
 * two keys are read from sources, in increasing precedence order; MCP callers
 * can inherit them without forwarding the rest of the parent's environment.
 */
export function applyPythonEncodingDefaults(
  env: Environment,
  options: {
    platform?: NodeJS.Platform;
    sources?: readonly (Readonly<Environment> | undefined)[];
  } = {},
): void {
  if ((options.platform ?? process.platform) !== 'win32') return;

  const sources = options.sources ?? [env];
  for (const [name, defaultValue] of Object.entries(WINDOWS_PYTHON_ENCODING_DEFAULTS)) {
    let value: string | undefined;
    for (const source of sources) {
      if (!source) continue;
      // Prefer the canonical spelling within one source. Across sources the
      // later explicit value wins, even when its spelling differs on Windows.
      const alias = Object.keys(source).find(key => key.toUpperCase() === name && source[key] !== undefined);
      const candidate = source[name] ?? (alias ? source[alias] : undefined);
      if (candidate !== undefined) value = candidate;
    }
    for (const key of Object.keys(env)) {
      if (key !== name && key.toUpperCase() === name) delete env[key];
    }
    env[name] = value || defaultValue;
  }
}
