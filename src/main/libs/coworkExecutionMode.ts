import type { CoworkExecutionMode } from '../coworkStore';

export const normalizeCoworkExecutionMode = (value?: string | null): CoworkExecutionMode => {
  if (value === 'auto' || value === 'local' || value === 'sandbox') {
    return value;
  }
  return 'local';
};

export const mapExecutionModeToSandboxMode = (
  mode: CoworkExecutionMode,
): 'off' | 'non-main' | 'all' => {
  if (mode === 'auto') {
    return 'non-main';
  }
  if (mode === 'sandbox') {
    return 'all';
  }
  return 'off';
};
