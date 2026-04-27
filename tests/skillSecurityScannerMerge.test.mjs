/**
 * Unit tests for skillSecurityScanner.ts — mergeReports()
 *
 * mergeReports() combines multiple SkillSecurityReport objects produced by
 * scanning individual skill directories into a single aggregate report.
 * It is a pure function: no filesystem access, no async behaviour.
 *
 * Behaviours under test:
 *   - Returns null for an empty input array.
 *   - Returns the first (and only) report unchanged for a single-element array.
 *   - Concatenates skill names with ', '.
 *   - Aggregates findings from all reports in input order.
 *   - Truncates aggregated findings to 100 entries (MAX_FINDINGS constant).
 *   - Risk score is max(computeRiskScore(truncated findings), max report score).
 *   - riskLevel is derived from the merged risk score.
 *   - scanDurationMs is the sum of all individual report durations.
 *   - dimensionSummary reflects the merged (possibly truncated) findings.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeReports } = require('../dist-electron/main/libs/skillSecurity/skillSecurityScanner.js');

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal SkillSecurityReport with sensible defaults.
 * The caller supplies only the fields relevant to each test.
 */
function makeReport(overrides = {}) {
  return {
    scannedAt: Date.now(),
    skillName: overrides.skillName ?? 'test-skill',
    riskLevel: overrides.riskLevel ?? 'safe',
    riskScore: overrides.riskScore ?? 0,
    findings: overrides.findings ?? [],
    dimensionSummary: overrides.dimensionSummary ?? {},
    scanDurationMs: overrides.scanDurationMs ?? 10,
  };
}

/**
 * Produce a finding with no contribution to the risk score (severity: 'info')
 * so the merged score stays predictable.
 */
function makeInfoFinding(ruleId, file = 'script.sh') {
  return {
    dimension: 'network',
    severity: 'info',
    ruleId,
    file,
    matchedPattern: 'example',
    description: 'test finding',
  };
}

function makeWarningFinding(ruleId, file = 'script.sh') {
  return {
    dimension: 'network',
    severity: 'warning',
    ruleId,
    file,
    matchedPattern: 'curl',
    description: 'network request',
  };
}

function makeDangerFinding(ruleId, file = 'run.sh') {
  return {
    dimension: 'dangerous_command',
    severity: 'danger',
    ruleId,
    file,
    matchedPattern: 'eval',
    description: 'dangerous command',
  };
}

function makeCriticalFinding(ruleId, file = 'run.sh') {
  return {
    dimension: 'process',
    severity: 'critical',
    ruleId,
    file,
    matchedPattern: 'exec()',
    description: 'obfuscated code',
  };
}

// ── null / identity cases ────────────────────────────────────────────────────

test('mergeReports returns null for an empty reports array', () => {
  assert.equal(mergeReports([]), null);
});

test('mergeReports returns the exact same report object for a single-element array', () => {
  const report = makeReport({ skillName: 'solo-skill', riskScore: 5, riskLevel: 'low' });
  const result = mergeReports([report]);
  assert.equal(result, report, 'should be the same object reference');
});

// ── skill name concatenation ─────────────────────────────────────────────────

test('mergeReports joins two skill names with ", "', () => {
  const a = makeReport({ skillName: 'docx' });
  const b = makeReport({ skillName: 'xlsx' });
  const result = mergeReports([a, b]);
  assert.equal(result.skillName, 'docx, xlsx');
});

test('mergeReports joins three skill names with ", "', () => {
  const a = makeReport({ skillName: 'alpha' });
  const b = makeReport({ skillName: 'beta' });
  const c = makeReport({ skillName: 'gamma' });
  const result = mergeReports([a, b, c]);
  assert.equal(result.skillName, 'alpha, beta, gamma');
});

// ── finding aggregation ──────────────────────────────────────────────────────

test('mergeReports collects findings from both reports in input order', () => {
  const f1 = makeInfoFinding('r1', 'a.sh');
  const f2 = makeWarningFinding('r2', 'b.sh');
  const a = makeReport({ findings: [f1] });
  const b = makeReport({ findings: [f2] });
  const result = mergeReports([a, b]);
  assert.equal(result.findings.length, 2);
  assert.deepEqual(result.findings[0], f1);
  assert.deepEqual(result.findings[1], f2);
});

test('mergeReports preserves empty findings when both reports are clean', () => {
  const a = makeReport();
  const b = makeReport();
  const result = mergeReports([a, b]);
  assert.equal(result.findings.length, 0);
});

test('mergeReports truncates aggregated findings to 100 entries', () => {
  // Build 60 unique findings per report → 120 total → should be capped at 100
  const makeFindings = (prefix, count) =>
    Array.from({ length: count }, (_, i) => makeInfoFinding(`${prefix}-rule-${i}`, `${prefix}-${i}.sh`));

  const a = makeReport({ findings: makeFindings('a', 60) });
  const b = makeReport({ findings: makeFindings('b', 60) });
  const result = mergeReports([a, b]);
  assert.equal(result.findings.length, 100);
  // Verify ordering: first 60 from report A, then first 40 from report B
  assert.equal(result.findings[0].ruleId, 'a-rule-0');
  assert.equal(result.findings[59].ruleId, 'a-rule-59');
  assert.equal(result.findings[60].ruleId, 'b-rule-0');
  assert.equal(result.findings[99].ruleId, 'b-rule-39');
});

// ── risk score ───────────────────────────────────────────────────────────────

test('mergeReports risk score is 0 when all reports have no findings and score 0', () => {
  const a = makeReport({ riskScore: 0 });
  const b = makeReport({ riskScore: 0 });
  const result = mergeReports([a, b]);
  assert.equal(result.riskScore, 0);
});

test('mergeReports takes the maximum individual report score when findings contribute less', () => {
  // Report A has riskScore=40 but no findings (computeRiskScore([]) = 0)
  // Report B has riskScore=10 and no findings
  // Merged score = max(computeRiskScore([]), max(40, 10)) = max(0, 40) = 40
  const a = makeReport({ riskScore: 40, riskLevel: 'medium' });
  const b = makeReport({ riskScore: 10, riskLevel: 'low' });
  const result = mergeReports([a, b]);
  assert.equal(result.riskScore, 40);
});

test('mergeReports computes score from merged findings when they exceed individual scores', () => {
  // 3 danger findings → 3 × 20 = 60 points; individual report scores are 0
  const findings = [
    makeDangerFinding('d1'),
    makeDangerFinding('d2'),
    makeDangerFinding('d3'),
  ];
  const a = makeReport({ riskScore: 0, findings });
  const b = makeReport({ riskScore: 0 });
  const result = mergeReports([a, b]);
  assert.equal(result.riskScore, 60);
});

test('mergeReports caps total risk score at 100', () => {
  // 3 critical findings = 3 × 50 = 150 → capped to 100
  const findings = [
    makeCriticalFinding('c1'),
    makeCriticalFinding('c2'),
    makeCriticalFinding('c3'),
  ];
  const a = makeReport({ riskScore: 0, findings });
  const b = makeReport({ riskScore: 0 });
  const result = mergeReports([a, b]);
  assert.equal(result.riskScore, 100);
});

// ── risk level ───────────────────────────────────────────────────────────────

test('mergeReports risk level is "safe" when score is 0', () => {
  const result = mergeReports([makeReport(), makeReport()]);
  assert.equal(result.riskLevel, 'safe');
});

test('mergeReports risk level is "low" for score 1–10', () => {
  // 2 warning findings = 2 × 5 = 10
  const findings = [makeWarningFinding('w1'), makeWarningFinding('w2')];
  const a = makeReport({ riskScore: 0, findings });
  const result = mergeReports([a, makeReport()]);
  assert.equal(result.riskScore, 10);
  assert.equal(result.riskLevel, 'low');
});

test('mergeReports risk level is "medium" for score 11–30', () => {
  // 1 danger + 1 warning = 20 + 5 = 25
  const findings = [makeDangerFinding('d1'), makeWarningFinding('w1')];
  const a = makeReport({ riskScore: 0, findings });
  const result = mergeReports([a, makeReport()]);
  assert.equal(result.riskScore, 25);
  assert.equal(result.riskLevel, 'medium');
});

test('mergeReports risk level is "high" for score 31–70', () => {
  // 1 critical = 50 → high
  const findings = [makeCriticalFinding('c1')];
  const a = makeReport({ riskScore: 0, findings });
  const result = mergeReports([a, makeReport()]);
  assert.equal(result.riskScore, 50);
  assert.equal(result.riskLevel, 'high');
});

test('mergeReports risk level is "critical" for score > 70', () => {
  // 2 critical = 100 → critical
  const findings = [makeCriticalFinding('c1'), makeCriticalFinding('c2')];
  const a = makeReport({ riskScore: 0, findings });
  const result = mergeReports([a, makeReport()]);
  assert.equal(result.riskScore, 100);
  assert.equal(result.riskLevel, 'critical');
});

// ── scanDurationMs ───────────────────────────────────────────────────────────

test('mergeReports sums scanDurationMs from all reports', () => {
  const a = makeReport({ scanDurationMs: 120 });
  const b = makeReport({ scanDurationMs: 350 });
  const result = mergeReports([a, b]);
  assert.equal(result.scanDurationMs, 470);
});

test('mergeReports sums scanDurationMs across three reports', () => {
  const a = makeReport({ scanDurationMs: 50 });
  const b = makeReport({ scanDurationMs: 75 });
  const c = makeReport({ scanDurationMs: 25 });
  const result = mergeReports([a, b, c]);
  assert.equal(result.scanDurationMs, 150);
});

// ── dimensionSummary ─────────────────────────────────────────────────────────

test('mergeReports dimensionSummary reflects merged findings dimensions', () => {
  const f1 = makeWarningFinding('w1', 'a.sh');   // dimension: network
  const f2 = makeDangerFinding('d1', 'b.sh');    // dimension: dangerous_command
  const a = makeReport({ findings: [f1] });
  const b = makeReport({ findings: [f2] });
  const result = mergeReports([a, b]);
  assert.ok(result.dimensionSummary.network, 'network dimension should appear');
  assert.ok(result.dimensionSummary.dangerous_command, 'dangerous_command dimension should appear');
  assert.equal(result.dimensionSummary.network.count, 1);
  assert.equal(result.dimensionSummary.dangerous_command.count, 1);
});

test('mergeReports dimensionSummary is empty when there are no findings', () => {
  const result = mergeReports([makeReport(), makeReport()]);
  assert.deepEqual(result.dimensionSummary, {});
});

test('mergeReports dimensionSummary tracks maxSeverity correctly', () => {
  const warning = makeWarningFinding('w1', 'a.sh');  // network / warning
  const info = makeInfoFinding('i1', 'b.sh');        // network / info
  const a = makeReport({ findings: [warning, info] });
  const result = mergeReports([a, makeReport()]);
  assert.equal(result.dimensionSummary.network.count, 2);
  assert.equal(result.dimensionSummary.network.maxSeverity, 'warning');
});
