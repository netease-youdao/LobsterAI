import path from 'path';

export const RemoteWorkerFile = {
  FileSnapshot: 'remoteFileSnapshotWorker.cjs',
  Projection: 'remoteProjectionWorker.js',
  LiveProjection: 'remoteLiveProjectionWorker.js',
  SecurityJournal: 'remoteSecurityJournalWorker.js',
  ImportSnapshot: 'remoteImportSnapshotWorker.js',
} as const;

/** Vite emits workers beside main.js; tsc emits them beside their unbundled callers.
 * Node worker_threads uses real paths, so packaged workers are explicitly unpacked. */
export function remoteWorkerPath(filename: typeof RemoteWorkerFile[keyof typeof RemoteWorkerFile], directory = __dirname): string {
  const physical = directory.replace(/([\\/][^\\/]+\.asar)(?=[\\/]|$)/u, '$1.unpacked');
  return path.join(physical, filename);
}
