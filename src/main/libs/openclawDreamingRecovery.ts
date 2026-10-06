import fs from 'fs';
import path from 'path';

import {
  DREAMING_RECOVERY_DIRECTORY,
  DREAMING_RECOVERY_LATEST_FILE,
  DREAMING_RECOVERY_REPORT_VERSION,
  OpenClawDreamingRecoveryOutcome,
  type OpenClawDreamingRecoveryReport,
  OpenClawDreamingRecoveryStage,
  type OpenClawDreamingRecoverySummary,
  OpenClawDreamingStateFile,
} from '../../shared/openclawEngine/dreamingRecovery';
import { OPENCLAW_STARTUP_COMPATIBILITY_VERSION } from '../../shared/openclawEngine/startupCompatibility';

const RUN_ID = /^[a-f0-9-]{36}$/;
const stringArray = (value: unknown): value is string[] => Array.isArray(value)
  && value.every(item => typeof item === 'string');

export function isDreamingRecoveryReport(value: any): value is OpenClawDreamingRecoveryReport {
  if (!value || value.reportVersion !== DREAMING_RECOVERY_REPORT_VERSION
    || value.runtimeVersion !== OPENCLAW_STARTUP_COMPATIBILITY_VERSION
    || !Object.values(OpenClawDreamingRecoveryOutcome).includes(value.outcome)
    || !Array.isArray(value.files) || value.files.length > 128 || !stringArray(value.blockers)
    || (value.manifestPath !== undefined && (typeof value.manifestPath !== 'string' || !path.isAbsolute(value.manifestPath)))) return false;
  if (!value.files.every((file: any) => file
    && Object.values(OpenClawDreamingStateFile).includes(file.fileName)
    && Object.values(OpenClawDreamingRecoveryStage).includes(file.stage)
    && stringArray(file.agentIds) && file.agentIds.length > 0
    && [file.sourcePath, file.backupPath, file.isolatedPath].every(item => typeof item === 'string' && path.isAbsolute(item))
    && Number.isSafeInteger(file.size) && file.size >= 0
    && typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256))) return false;
  if (value.outcome === OpenClawDreamingRecoveryOutcome.Recovered) {
    return value.files.length > 0 && Boolean(value.manifestPath) && !value.blockers.length
      && value.files.every((file: any) => file.stage === OpenClawDreamingRecoveryStage.Verified);
  }
  return value.outcome !== OpenClawDreamingRecoveryOutcome.NotApplicable || (!value.files.length && !value.blockers.length);
}

export function summarizeDreamingRecovery(report: OpenClawDreamingRecoveryReport, recordedAt = new Date().toISOString()): OpenClawDreamingRecoverySummary | undefined {
  if (!report.manifestPath || !report.files.length) return undefined;
  const quarantinedFileCount = report.files.filter(file => file.stage === OpenClawDreamingRecoveryStage.Verified).length;
  return {
    manifestPath: report.manifestPath,
    affectedWorkspaceCount: new Set(report.files.map(file => path.dirname(file.sourcePath))).size,
    quarantinedFileCount,
    pendingFileCount: report.files.length - quarantinedFileCount,
    recordedAt,
  };
}

/** Reads one small index/manifest, never scans workspaces or triggers recovery. */
export function readDreamingRecoverySummary(stateDir: string): OpenClawDreamingRecoverySummary | undefined {
  try {
    const root = path.join(stateDir, DREAMING_RECOVERY_DIRECTORY);
    const read = (filePath: string) => {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid recovery record.');
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    };
    const { runId } = read(path.join(root, DREAMING_RECOVERY_LATEST_FILE));
    if (typeof runId !== 'string' || !RUN_ID.test(runId)) return undefined;
    const manifestPath = path.join(root, runId, 'manifest.json');
    const report = read(manifestPath);
    if (!isDreamingRecoveryReport(report) || report.manifestPath !== manifestPath) return undefined;
    return summarizeDreamingRecovery(report, typeof report.recordedAt === 'string' ? report.recordedAt : '');
  } catch {
    // Recovery history is informational and cannot prevent a healthy startup.
    return undefined;
  }
}
