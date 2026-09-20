import { getIMConfigSaveStatus, IMConfigSaveStatus, type IMConfigSyncResult } from '../../../shared/im/configSync';

export function IMConfigSyncNotice({ result, message }: { result: IMConfigSyncResult | null; message: string }) {
  if (!result || getIMConfigSaveStatus(result) !== IMConfigSaveStatus.Pending) return null;
  return <div role="status" className="mx-9 my-3 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
    {message}
  </div>;
}
