import fs from 'fs';
import path from 'path';

import { getLibraryArtifactTypeForExtension, LibraryOrigin, LibraryRelationKind } from '../../shared/library/constants';
import type { LibraryArtifactCandidate } from '../../shared/library/types';
import type { RemoteOwner } from '../../shared/remote/constants';
import { type RemoteFilePolicy, RemoteFileReason, remoteFileRule } from '../../shared/remote/files';
import type { LibraryIndexedFile } from '../library/libraryLocalStore';
import { sameOwner } from './canonical';
import { captureDeliveryBaseline, changedDeliveredFile, deliveredFileDeclarations, type DeliveryBaseline, RemoteFileDeliveryKind } from './remoteDeliveredFiles';
import { captureRemoteFileSnapshot, type RemoteFileSnapshot } from './remoteFileSnapshots';
import type { RemoteStore } from './remoteStore';

export interface DeliveredFileDependencies {
  store: RemoteStore;
  cacheRoot: string;
  access(filePath: string): { assertAllowed(): void };
  recordArtifact?(candidate: LibraryArtifactCandidate, owner: RemoteOwner, assertCurrent: () => void,
    validateIndexed: (file: LibraryIndexedFile) => void): Promise<boolean>;
}
import { captureRemoteFileTelemetry, RemoteFileTelemetry as Telemetry,remoteFileTelemetryReason } from './remoteFileTelemetry';

interface PendingRun {
  owner: RemoteOwner;
  runId: string;
  baseline?: DeliveryBaseline;
  current(): boolean;
  retryAt: number;
  captured: Set<string>;
}
interface DeliveryMessage { id: string; type: string; content: string | null; metadata: Record<string, unknown> }
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const writeTools = new Set(['write', 'edit', 'multiedit', 'write_file', 'edit_file', 'create_file']);
const shellTools = new Set(['exec', 'bash']);
const MAX_PENDING_RUNS = 32;
const MAX_FINAL_AGE_MS = 10 * 60_000;

/** Metadata observation never uploads a directory: explicit live deliveries retain owner, run and immutable-file evidence. */
export class RemoteDeliveredFileSync {
  private readonly pending = new Map<string, PendingRun>();
  constructor(private readonly deps: DeliveredFileDependencies) {}
  clear(): void { this.pending.clear(); }

  /** Optional discovery never delays engine dispatch; only metadata predating this boundary can authorize discovery. */
  startPreparation(sessionId: string, roots: string[], owner: RemoteOwner, validEpoch: () => boolean): void {
    const observedBefore = Date.now();
    void this.prepare(sessionId,roots,owner,validEpoch,observedBefore).catch(() => { /* Discovery is optional. */ });
  }
  async prepare(sessionId: string, roots: string[], owner: RemoteOwner, validEpoch: () => boolean, observedBefore?: number): Promise<void> {
    if (!this.deps.recordArtifact || !validEpoch() || !sameOwner(owner, this.deps.store.owner(sessionId))) return;
    const telemetry = captureRemoteFileTelemetry(owner, { local_session_id: sessionId, direction: Telemetry.Artifact, operation_kind: 'file_publication' });
    const run = this.deps.store.run(sessionId);
    const ordinal = this.deps.store.get<string>(`fileRunOrdinal:${sessionId}`);
    if (!run || terminal.has(run.status) || !ordinal) return;
    // A continuation of the same run must retain its pre-execution baseline.
    if (this.pending.get(sessionId)?.runId === run.runId) return;
    if (this.pending.size >= MAX_PENDING_RUNS) this.pending.delete(this.pending.keys().next().value!);
    const entry: PendingRun = {
      owner, runId: run.runId, retryAt: 0, captured: new Set(),
      current: () => this.pending.get(sessionId) === entry && validEpoch() && sameOwner(owner, this.deps.store.owner(sessionId))
        && this.deps.store.run(sessionId)?.runId === run.runId
        && this.deps.store.get<string>(`fileRunOrdinal:${sessionId}`) === ordinal,
    };
    this.pending.set(sessionId, entry);
    try {
      const baseline = await captureDeliveryBaseline(roots.slice(0, 2), entry.current, observedBefore);
      if (!entry.current() || terminal.has(this.deps.store.run(sessionId)!.status) || !baseline.directories.length) {
        if (this.pending.get(sessionId) === entry) this.pending.delete(sessionId);
        return;
      }
      entry.baseline = baseline;
      telemetry.emit(Telemetry.Stage, { stage: Telemetry.Discovery, outcome: Telemetry.Succeeded, run_id: run.runId });
    } catch (error) { if (this.pending.get(sessionId) === entry) this.pending.delete(sessionId);
      telemetry.emit(Telemetry.Stage, { stage: Telemetry.Discovery, outcome: Telemetry.Failed, run_id: run.runId, reason: remoteFileTelemetryReason(error) }); }
  }

  private messages(sessionId: string, runId: string): DeliveryMessage[] {
    const rows = this.deps.store.db.prepare(`SELECT id,type,CASE WHEN type='assistant' THEN CASE WHEN length(content)<=65536 THEN content ELSE NULL END ELSE '' END AS content,metadata FROM cowork_messages
      WHERE session_id=? AND length(metadata)<=65536 AND type IN ('assistant','tool_use','tool_result') ORDER BY sequence DESC LIMIT 160`).all(sessionId) as Array<{
        id: string; type: string; content: string | null; metadata: string;
      }>;
    return rows.flatMap(row => {
      try {
        const metadata = JSON.parse(row.metadata || '{}') as Record<string, unknown>;
        return metadata.remoteRunId === runId ? [{ ...row, metadata }] : [];
      } catch { return []; }
    });
  }

  private declarationCurrent(sessionId: string, runId: string, final: DeliveryMessage): boolean {
    const row = this.deps.store.db.prepare(`SELECT content,metadata FROM cowork_messages
      WHERE id=? AND session_id=? AND type='assistant' AND length(content)<=65536 AND length(metadata)<=65536`)
      .get(final.id, sessionId) as { content: string; metadata: string } | undefined;
    if (!row || row.content !== final.content) return false;
    try {
      const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      return metadata.remoteRunId === runId && metadata.isThinking !== true && metadata.isStreaming !== true;
    } catch { return false; }
  }

  private hasSuccessfulProducer(messages: DeliveryMessage[]): boolean {
    return messages.some(result => {
      if (result.type !== 'tool_result' || result.metadata.isFinal !== true || result.metadata.isError === true
        || result.metadata.isStreaming === true || typeof result.metadata.toolUseId !== 'string') return false;
      const call = messages.find(message => message.type === 'tool_use' && message.metadata.toolUseId === result.metadata.toolUseId);
      const toolName = String(call?.metadata.toolName || '').toLowerCase();
      if (writeTools.has(toolName)) return true;
      const details = result.metadata.toolResultDetails as { exitCode?: unknown; status?: unknown } | undefined;
      return shellTools.has(toolName) && details?.exitCode === 0 && details.status !== 'running';
    });
  }

  async collect(owner: RemoteOwner, policy: RemoteFilePolicy, current: (sessionId: string) => boolean,
    accept: (sessionId: string, messageId: string, runId: string, filePath: string, snapshot: RemoteFileSnapshot) => boolean): Promise<void> {
    if (!policy.features.artifactPublish || !this.deps.recordArtifact) return;
    for (const [sessionId, entry] of [...this.pending].slice(0, MAX_PENDING_RUNS)) {
      const telemetry = captureRemoteFileTelemetry(owner, { local_session_id: sessionId, run_id: entry.runId, direction: Telemetry.Artifact, operation_kind: 'file_publication' });
      if (!entry.current() || !current(sessionId) || !sameOwner(owner, entry.owner)) { this.pending.delete(sessionId); continue; }
      const run = this.deps.store.run(sessionId)!;
      if (!terminal.has(run.status) || !entry.baseline || Date.now() < entry.retryAt) continue;
      const finishedAt = Date.parse(run.finishedAt || '');
      if (run.status !== 'succeeded' || !Number.isFinite(finishedAt) || Date.now() - finishedAt > MAX_FINAL_AGE_MS) {
        this.pending.delete(sessionId); continue;
      }
      const messages = this.messages(sessionId, run.runId);
      const final = messages.find(message => message.type === 'assistant' && message.metadata.isThinking !== true
        && message.metadata.isStreaming !== true);
      // An oversized latest reply is not a truncated declaration or permission to replay an earlier reply.
      if (!final || final.content === null) { this.pending.delete(sessionId); continue; }
      const produced = this.hasSuccessfulProducer(messages);
      let retry = false;
      for (const delivery of deliveredFileDeclarations(final.content).slice(0, Math.min(20, policy.limits.maxTaskArtifactCount))) {
        const explicitMedia = delivery.kind === RemoteFileDeliveryKind.Media, filePath = delivery.filePath;
        if (!explicitMedia && !produced) continue;
        if (entry.captured.has(filePath)) continue;
        const valid = (): boolean => entry.current() && current(sessionId)
          && this.deps.store.run(sessionId)?.finishedAt === run.finishedAt
          && (!explicitMedia || this.declarationCurrent(sessionId, run.runId, final));
        let snapshot: RemoteFileSnapshot | undefined;
        let retained = false;
        try {
          // This lease is captured before registering a new relation, so registration cannot grant access to another owner's file.
          const lease = this.deps.access(filePath);
          const assert = (): void => { if (!valid()) throw new Error(RemoteFileReason.Access); lease.assertAllowed(); };
          assert();
          const receipt = await changedDeliveredFile(entry.baseline, filePath, finishedAt + 1, valid, explicitMedia);
          const detectedType = getLibraryArtifactTypeForExtension(path.extname(filePath));
          if (!receipt || !detectedType || remoteFileRule(policy, path.basename(filePath), receipt.sizeBytes, true)) continue;
          snapshot = await captureRemoteFileSnapshot(filePath, this.deps.cacheRoot, owner, 30 * 1024 * 1024, assert);
          assert();
          if (snapshot.identity !== receipt.identity) throw new Error(RemoteFileReason.Source);
          const validateIndexed = (file: LibraryIndexedFile): void => {
            assert();
            const stat = fs.lstatSync(filePath);
            const root = path.dirname(filePath), directory = entry.baseline!.directories.find(item => item.path === root)!;
            const rootStat = fs.lstatSync(root);
            if (!stat.isFile() || stat.isSymbolicLink() || !rootStat.isDirectory() || rootStat.isSymbolicLink()
              || `${rootStat.dev}:${rootStat.ino}` !== directory.identity || fs.realpathSync(filePath) !== filePath
              || `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` !== receipt.identity
              || file.filePath !== filePath || file.fileIdentity !== `${stat.dev}:${stat.ino}:${Math.trunc(stat.birthtimeMs)}`
              || file.sizeBytes !== stat.size || file.fileMtimeMs !== Math.trunc(stat.mtimeMs)) throw new Error(RemoteFileReason.Source);
          };
          const recorded = await this.deps.recordArtifact({ sessionId, messageId: final.id, filePath, detectedType,
            relationKind: explicitMedia ? LibraryRelationKind.Referenced : LibraryRelationKind.Modified, relatedAt: finishedAt, origin: LibraryOrigin.Conversation }, owner, assert, validateIndexed);
          assert();
          if (!recorded || !accept(sessionId, final.id, run.runId, filePath, snapshot)) throw new Error(RemoteFileReason.Source);
          retained = true;
          entry.captured.add(filePath);
          telemetry.emit(Telemetry.Stage, { stage: Telemetry.Snapshot, outcome: Telemetry.Succeeded });
        } catch (error) { retry = true; telemetry.emit(Telemetry.Stage, { stage: Telemetry.Snapshot, outcome: Telemetry.Deferred, reason: remoteFileTelemetryReason(error) }); /* Retry privately; never reject the local task or alter ordinary file references. */ }
        finally { if (snapshot && !retained) await fs.promises.rm(snapshot.path, { force: true }).catch((): void => undefined); }
      }
      if (this.pending.get(sessionId) !== entry) continue;
      if (retry && entry.current()) entry.retryAt = Date.now() + 60_000;
      else this.pending.delete(sessionId);
    }
  }
}
