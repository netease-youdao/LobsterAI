import * as fs from 'fs';
import * as path from 'path';
import {
  SecurityFinding,
  FindingSeverity,
  SecurityRiskLevel,
  SkillSecurityReport,
  SecurityDimension,
} from './skillSecurityTypes';
import { getRulesForFile } from './skillSecurityRules';
import { scanPromptInjection } from './skillSecurityPromptAudit';

const MAX_FILES = 500;
const MAX_FILE_SIZE_BYTES = 512 * 1024;
const MAX_FINDINGS = 100;
const SCAN_TIMEOUT_MS = 5000;
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.svn', '.hg']);
const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);
const SKILL_FILE_NAME = 'SKILL.md';

interface ScannableFile {
  absolutePath: string;
  relativePath: string;
  extension: string;
}

// ── js-x-ray Warning → SecurityFinding mapping ───────────────────────────────

interface JsxrayWarningMap {
  dimension: SecurityDimension;
  severity: FindingSeverity;
}

const JSXRAY_WARNING_MAP: Record<string, JsxrayWarningMap> = {
  'data-exfiltration': { dimension: 'network', severity: 'critical' },
  'unsafe-command': { dimension: 'dangerous_command', severity: 'danger' },
  'obfuscated-code': { dimension: 'process', severity: 'critical' },
  'encoded-literal': { dimension: 'network', severity: 'warning' },
  'unsafe-stmt': { dimension: 'dangerous_command', severity: 'danger' },
  'serialize-environment': { dimension: 'file_access', severity: 'info' },
  'shady-link': { dimension: 'network', severity: 'warning' },
  'unsafe-import': { dimension: 'process', severity: 'info' },
  'weak-crypto': { dimension: 'network', severity: 'info' },
  'suspicious-file': { dimension: 'process', severity: 'critical' },
  'insecure-random': { dimension: 'network', severity: 'info' },
  'monkey-patch': { dimension: 'process', severity: 'warning' },
  'prototype-pollution': { dimension: 'process', severity: 'danger' },
  'sql-injection': { dimension: 'dangerous_command', severity: 'danger' },
};

// ── Scoring ───────────────────────────────────────────────────────────────────

const SEVERITY_SCORES: Record<FindingSeverity, number> = {
  info: 0,
  warning: 5,
  danger: 20,
  critical: 50,
};

function computeRiskScore(findings: SecurityFinding[]): number {
  let score = 0;
  for (const f of findings) {
    score += SEVERITY_SCORES[f.severity];
  }
  return Math.min(score, 100);
}

function riskScoreToLevel(score: number): SecurityRiskLevel {
  if (score === 0) return 'safe';
  if (score <= 10) return 'low';
  if (score <= 30) return 'medium';
  if (score <= 70) return 'high';
  return 'critical';
}

// ── File collection ───────────────────────────────────────────────────────────

function collectScannableFiles(rootDir: string): ScannableFile[] {
  const files: ScannableFile[] = [];
  const seen = new Set<string>();
  const queue = [rootDir];

  while (queue.length > 0 && files.length < MAX_FILES) {
    const current = queue.shift()!;
    const resolved = path.resolve(current);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      if (!entry.name || entry.name.startsWith('.') && SKIP_DIRS.has(entry.name)) continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      const fullPath = path.join(current, entry.name);

      if (entry.isSymbolicLink()) {
        // Skip symlinks to avoid loops and escapes
        continue;
      }

      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > MAX_FILE_SIZE_BYTES) continue;
          if (stat.size === 0) continue;
        } catch {
          continue;
        }

        // Skip binary files (check first 512 bytes for null bytes)
        try {
          const buf = Buffer.alloc(512);
          const fd = fs.openSync(fullPath, 'r');
          const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
          fs.closeSync(fd);
          if (buf.subarray(0, bytesRead).includes(0)) continue;
        } catch {
          continue;
        }

        const ext = path.extname(entry.name).toLowerCase();
        files.push({
          absolutePath: fullPath,
          relativePath: path.relative(rootDir, fullPath),
          extension: ext,
        });
      }
    }
  }

  return files;
}

// ── Regex engine scan ─────────────────────────────────────────────────────────

function scanFileWithRegex(file: ScannableFile, content: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const rules = getRulesForFile(file.relativePath);
  if (rules.length === 0) return findings;

  const lines = content.split('\n');

  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          findings.push({
            dimension: rule.dimension,
            severity: rule.severity,
            ruleId: rule.id,
            file: file.relativePath,
            line: i + 1,
            matchedPattern: lines[i].trim().substring(0, 200),
            description: rule.description,
          });
          break; // One match per pattern per file
        }
      }
    }
  }

  return findings;
}

// ── package.json audit ────────────────────────────────────────────────────────

function auditPackageJson(pkgPath: string, relativePath: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  try {
    const content = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(content);

    // Check for suspicious install scripts
    const scripts = pkg.scripts || {};
    const dangerousScripts = ['preinstall', 'install', 'postinstall'];
    for (const scriptName of dangerousScripts) {
      if (scripts[scriptName]) {
        findings.push({
          dimension: 'process',
          severity: 'warning',
          ruleId: 'package.install_script',
          file: relativePath,
          matchedPattern: `${scriptName}: ${String(scripts[scriptName]).substring(0, 200)}`,
          description: 'securityFindingInstallScript',
        });
      }
    }
  } catch {
    // Ignore parse errors
  }
  return findings;
}

// ── js-x-ray engine ──────────────────────────────────────────────────────────

let jsxrayModule: any = null;
let jsxrayLoadFailed = false;

async function loadJsxray(): Promise<any> {
  if (jsxrayModule) return jsxrayModule;
  if (jsxrayLoadFailed) return null;
  try {
    // Use indirect import() to prevent tsc from converting it to require().
    // js-x-ray is ESM-only; CJS require() cannot load it.
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    jsxrayModule = await dynamicImport('@nodesecure/js-x-ray');
    return jsxrayModule;
  } catch (err) {
    console.warn('[SkillSecurity] Failed to load @nodesecure/js-x-ray:', err);
    jsxrayLoadFailed = true;
    return null;
  }
}

async function scanFileWithJsxray(
  file: ScannableFile,
  content: string
): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];
  const mod = await loadJsxray();
  if (!mod) return findings;

  try {
    const analyser = new mod.AstAnalyser({ sensitivity: 'aggressive' });
    const result = analyser.analyse(content, { module: false });

    if (result.warnings && Array.isArray(result.warnings)) {
      for (const warning of result.warnings) {
        const mapping = JSXRAY_WARNING_MAP[warning.kind];
        if (!mapping) continue;

        const line = warning.location?.[0]?.start?.line
          ?? warning.location?.start?.line
          ?? undefined;

        findings.push({
          dimension: mapping.dimension,
          severity: mapping.severity,
          ruleId: `jsxray.${warning.kind}`,
          file: file.relativePath,
          line,
          matchedPattern: String(warning.value ?? warning.source ?? warning.kind).substring(0, 200),
          description: `securityFindingJsxray_${warning.kind.replace(/-/g, '_')}`,
        });
      }
    }
  } catch (err) {
    // AST parse failure — record as info, don't block scanning
    findings.push({
      dimension: 'process',
      severity: 'info',
      ruleId: 'jsxray.parse_error',
      file: file.relativePath,
      matchedPattern: `Parse error: ${err instanceof Error ? err.message : 'unknown'}`.substring(0, 200),
      description: 'securityFindingParseError',
    });
  }

  return findings;
}

// ── Build dimension summary ──────────────────────────────────────────────────

function buildDimensionSummary(
  findings: SecurityFinding[]
): Partial<Record<SecurityDimension, { count: number; maxSeverity: FindingSeverity }>> {
  const summary: Partial<Record<SecurityDimension, { count: number; maxSeverity: FindingSeverity }>> = {};
  const severityOrder: FindingSeverity[] = ['info', 'warning', 'danger', 'critical'];

  for (const f of findings) {
    const existing = summary[f.dimension];
    if (!existing) {
      summary[f.dimension] = { count: 1, maxSeverity: f.severity };
    } else {
      existing.count++;
      if (severityOrder.indexOf(f.severity) > severityOrder.indexOf(existing.maxSeverity)) {
        existing.maxSeverity = f.severity;
      }
    }
  }

  return summary;
}

// ── Parse SKILL.md metadata ──────────────────────────────────────────────────

function parseSkillName(skillDir: string): string {
  const skillMdPath = path.join(skillDir, SKILL_FILE_NAME);
  try {
    const content = fs.readFileSync(skillMdPath, 'utf-8');
    const nameMatch = /^name:\s*(.+)$/m.exec(content);
    if (nameMatch) return nameMatch[1].trim();
  } catch {
    // Ignore
  }
  return path.basename(skillDir);
}

// ── Main scanner ─────────────────────────────────────────────────────────────

export async function scanSkillSecurity(skillDir: string): Promise<SkillSecurityReport> {
  const startTime = Date.now();
  const allFindings: SecurityFinding[] = [];
  const skillName = parseSkillName(skillDir);

  try {
    // 1. Collect scannable files
    const files = collectScannableFiles(skillDir);

    // 2. Scan each file
    for (const file of files) {
      if (Date.now() - startTime > SCAN_TIMEOUT_MS - 500) break;
      if (allFindings.length >= MAX_FINDINGS) break;

      let content: string;
      try {
        content = fs.readFileSync(file.absolutePath, 'utf-8');
      } catch {
        continue;
      }

      // SKILL.md → prompt injection audit
      if (path.basename(file.absolutePath) === SKILL_FILE_NAME) {
        const promptFindings = scanPromptInjection(content, file.relativePath);
        allFindings.push(...promptFindings);
        continue;
      }

      // JS/TS → js-x-ray AST analysis
      if (JS_EXTENSIONS.has(file.extension)) {
        const jsFindings = await scanFileWithJsxray(file, content);
        allFindings.push(...jsFindings);

        // Also run regex rules for JS files (catch patterns js-x-ray might miss)
        const regexFindings = scanFileWithRegex(file, content);
        allFindings.push(...regexFindings);
        continue;
      }

      // All other files → regex engine
      const regexFindings = scanFileWithRegex(file, content);
      allFindings.push(...regexFindings);
    }

    // 3. Audit package.json if present
    const pkgJsonPath = path.join(skillDir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      const pkgFindings = auditPackageJson(pkgJsonPath, 'package.json');
      allFindings.push(...pkgFindings);
    }

    // Also check scripts/package.json
    const scriptsPkgPath = path.join(skillDir, 'scripts', 'package.json');
    if (fs.existsSync(scriptsPkgPath)) {
      const scriptsPkgFindings = auditPackageJson(scriptsPkgPath, 'scripts/package.json');
      allFindings.push(...scriptsPkgFindings);
    }
  } catch (err) {
    console.warn('[SkillSecurity] Scan error (non-blocking):', err);
  }

  // Deduplicate: same ruleId + same file → keep only the first occurrence
  const seen = new Set<string>();
  const deduped: SecurityFinding[] = [];
  for (const f of allFindings) {
    const key = `${f.ruleId}::${f.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(f);
  }

  const truncatedFindings = deduped.slice(0, MAX_FINDINGS);
  const riskScore = computeRiskScore(truncatedFindings);

  return {
    scannedAt: Date.now(),
    skillName,
    riskLevel: riskScoreToLevel(riskScore),
    riskScore,
    findings: truncatedFindings,
    dimensionSummary: buildDimensionSummary(truncatedFindings),
    scanDurationMs: Date.now() - startTime,
  };
}

/**
 * Scan multiple skill directories and merge results.
 * Used when a download source contains multiple skills.
 */
export async function scanMultipleSkillDirs(
  skillDirs: string[]
): Promise<SkillSecurityReport[]> {
  const reports: SkillSecurityReport[] = [];
  for (const dir of skillDirs) {
    reports.push(await scanSkillSecurity(dir));
  }
  return reports;
}

/**
 * Merge multiple reports into one aggregate report.
 */
export function mergeReports(reports: SkillSecurityReport[]): SkillSecurityReport | null {
  if (reports.length === 0) return null;
  if (reports.length === 1) return reports[0];

  const allFindings: SecurityFinding[] = [];
  let maxRiskScore = 0;
  const names: string[] = [];

  for (const r of reports) {
    allFindings.push(...r.findings);
    if (r.riskScore > maxRiskScore) maxRiskScore = r.riskScore;
    names.push(r.skillName);
  }

  const truncated = allFindings.slice(0, MAX_FINDINGS);
  const score = Math.max(computeRiskScore(truncated), maxRiskScore);

  return {
    scannedAt: Date.now(),
    skillName: names.join(', '),
    riskLevel: riskScoreToLevel(score),
    riskScore: score,
    findings: truncated,
    dimensionSummary: buildDimensionSummary(truncated),
    scanDurationMs: reports.reduce((sum, r) => sum + r.scanDurationMs, 0),
  };
}
