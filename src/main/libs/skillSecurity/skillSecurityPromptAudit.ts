import { SecurityFinding } from './skillSecurityTypes';

/**
 * Prompt injection detection rules for SKILL.md files.
 * These rules look for instructions that attempt to manipulate Claude
 * into performing dangerous actions.
 */

interface PromptAuditRule {
  id: string;
  severity: 'warning' | 'danger' | 'critical';
  patterns: RegExp[];
  description: string;
}

const PROMPT_INJECTION_RULES: PromptAuditRule[] = [
  {
    id: 'prompt_injection.ignore_instructions',
    severity: 'critical',
    patterns: [
      /ignore\s+(all\s+)?(previous|above|prior|earlier)\s+(instructions|rules|guidelines)/i,
      /disregard\s+(all\s+)?(previous|safety|system)\s+(instructions|rules|prompts)/i,
      /forget\s+(everything|all)\s+(you|that)\s+(were|was|have\s+been)\s+told/i,
      /override\s+(system|safety|security)\s+(prompt|instructions|settings)/i,
      /you\s+are\s+now\s+(an?\s+)?(unrestricted|unfiltered|jailbroken)/i,
      /pretend\s+(you\s+are|to\s+be)\s+(an?\s+)?(unrestricted|admin|root)/i,
    ],
    description: 'securityFindingPromptOverride',
  },
  {
    id: 'prompt_injection.hidden_instructions',
    severity: 'danger',
    patterns: [
      /<!--[\s\S]*?(execute|run|install|download|curl|wget|fetch|eval|exec)[\s\S]*?-->/i,
      /\[.*?\]\(javascript:/i,
      /!\[.*?\]\(data:.*?base64/i,
    ],
    description: 'securityFindingHiddenInstructions',
  },
  {
    id: 'prompt_injection.data_exfil_instruction',
    severity: 'critical',
    patterns: [
      /send\s+(the\s+)?(user('s)?|their)\s+(api\s*key|password|token|secret|credential|ssh|private\s*key)/i,
      /exfiltrate|steal\s+(credentials|tokens|keys|secrets)/i,
      /read\s+(the\s+)?\.env\s+(file\s+)?and\s+send/i,
      /upload\s+(the\s+)?(user('s)?|their)\s+(files?|data|credentials)/i,
    ],
    description: 'securityFindingDataExfilInstruction',
  },
  {
    id: 'prompt_injection.privilege_escalation',
    severity: 'danger',
    patterns: [
      /always\s+(approve|allow|accept|run)\s+(all\s+)?tool\s+(use|calls|executions?)/i,
      /never\s+ask\s+(for\s+)?(permission|confirmation|approval)/i,
      /automatically\s+(run|execute)\s+without\s+(asking|confirmation)/i,
      /bypass\s+(security|permission|sandbox|safety)/i,
    ],
    description: 'securityFindingPrivilegeEscalation',
  },
  {
    id: 'prompt_injection.unicode_obfuscation',
    severity: 'warning',
    patterns: [
      /[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/,
      /[\u0300-\u036F]{3,}/,
    ],
    description: 'securityFindingUnicodeObfuscation',
  },
  {
    id: 'prompt_injection.role_hijack',
    severity: 'danger',
    patterns: [
      /\[SYSTEM\]|\[ADMIN\]|\[ROOT\]/,
      /\bhuman\s*:\s*/i,
      /\bassistant\s*:\s*/i,
    ],
    description: 'securityFindingRoleHijack',
  },
];

/**
 * Scan SKILL.md content for prompt injection attacks.
 */
export function scanPromptInjection(content: string, filePath: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = content.split('\n');

  for (const rule of PROMPT_INJECTION_RULES) {
    for (const pattern of rule.patterns) {
      // Check full content for multiline patterns (like HTML comments)
      if (pattern.flags.includes('s') || rule.id === 'prompt_injection.hidden_instructions') {
        const match = pattern.exec(content);
        if (match) {
          const lineNumber = content.substring(0, match.index).split('\n').length;
          findings.push({
            dimension: 'prompt_injection',
            severity: rule.severity,
            ruleId: rule.id,
            file: filePath,
            line: lineNumber,
            matchedPattern: match[0].substring(0, 200),
            description: rule.description,
          });
        }
        continue;
      }

      // Check line by line for single-line patterns
      for (let i = 0; i < lines.length; i++) {
        const match = pattern.exec(lines[i]);
        if (match) {
          findings.push({
            dimension: 'prompt_injection',
            severity: rule.severity,
            ruleId: rule.id,
            file: filePath,
            line: i + 1,
            matchedPattern: match[0].substring(0, 200),
            description: rule.description,
          });
          break; // One match per rule per file is enough
        }
      }
    }
  }

  // Structural check: hidden content ratio
  const htmlCommentPattern = /<!--[\s\S]*?-->/g;
  let hiddenLength = 0;
  let match;
  while ((match = htmlCommentPattern.exec(content)) !== null) {
    hiddenLength += match[0].length;
  }
  const visibleLength = content.length - hiddenLength;
  if (visibleLength > 0 && hiddenLength / visibleLength > 0.3) {
    findings.push({
      dimension: 'prompt_injection',
      severity: 'warning',
      ruleId: 'prompt_injection.excessive_hidden_content',
      file: filePath,
      matchedPattern: `Hidden content ratio: ${Math.round((hiddenLength / visibleLength) * 100)}%`,
      description: 'securityFindingExcessiveHiddenContent',
    });
  }

  return findings;
}
