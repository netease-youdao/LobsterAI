export type ShellAppFileIconSize = 'normal' | 'large';

export function resolveShellAppFileIconSize(platform: NodeJS.Platform): ShellAppFileIconSize {
  return platform === 'linux' ? 'large' : 'normal';
}
