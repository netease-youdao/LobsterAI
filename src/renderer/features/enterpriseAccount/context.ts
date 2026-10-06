import type { EnterpriseAccountContext } from '../../../shared/enterpriseAccount/types';
import { store } from '../../store';
import { logEnterpriseAccountDiagnostic } from './diagnostics';
import { setEnterpriseAccountContext } from './enterpriseAccountSlice';

export function applyEnterpriseAccountContext(
  context: EnterpriseAccountContext | null | undefined,
): EnterpriseAccountContext | null {
  const normalizedContext = context ?? null;
  const previousContext = store.getState().enterpriseAccount.context;
  store.dispatch(setEnterpriseAccountContext(normalizedContext));
  if (
    previousContext?.enterpriseId !== normalizedContext?.enterpriseId
    || previousContext?.role !== normalizedContext?.role
  ) {
    logEnterpriseAccountDiagnostic(
      'debug',
      normalizedContext
        ? `applied enterprise context with role ${normalizedContext.role}`
        : 'cleared enterprise context',
    );
  }
  return normalizedContext;
}

export async function refreshEnterpriseAccountContext(
  options: {
    shouldApply?: () => boolean;
  } = {},
): Promise<EnterpriseAccountContext | null> {
  logEnterpriseAccountDiagnostic('debug', 'requesting enterprise context from main process');
  try {
    const result = await window.electron.enterpriseAccount.getContext();
    if (options.shouldApply && !options.shouldApply()) {
      logEnterpriseAccountDiagnostic(
        'debug',
        'discarded stale enterprise context response after account change',
      );
      return store.getState().enterpriseAccount.context;
    }
    if (!result.success) {
      logEnterpriseAccountDiagnostic(
        'warn',
        'enterprise context refresh returned a fallback',
        result.error,
      );
    }
    return applyEnterpriseAccountContext(result.context);
  } catch (error) {
    logEnterpriseAccountDiagnostic('warn', 'enterprise context IPC failed', error);
    return store.getState().enterpriseAccount.context;
  }
}
