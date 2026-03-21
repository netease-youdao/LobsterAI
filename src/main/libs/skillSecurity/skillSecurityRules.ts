import { SecurityRule } from './skillSecurityTypes';

// ── Dimension 1: File Access ──────────────────────────────────────────────────

const FILE_ACCESS_RULES: SecurityRule[] = [
  {
    id: 'file_access.ssh_keys',
    dimension: 'file_access',
    severity: 'critical',
    filePatterns: ['**/*.sh', '**/*.bash', '**/*.js', '**/*.ts', '**/*.ps1'],
    patterns: [
      /\.ssh\/(id_rsa|id_ed25519|id_ecdsa|id_dsa|authorized_keys|known_hosts|config)\b/,
      /cat\s+~?\/?\.ssh\//,
      /readFile[Ss]ync\(.*\.ssh/,
      /Get-Content.*\.ssh/,
    ],
    description: 'securityFindingSshKeyAccess',
  },
  {
    id: 'file_access.aws_credentials',
    dimension: 'file_access',
    severity: 'critical',
    filePatterns: ['**/*.sh', '**/*.js', '**/*.ts', '**/*.ps1'],
    patterns: [
      /\.aws\/(credentials|config)\b/,
      /AWS_SECRET_ACCESS_KEY/,
      /AWS_SESSION_TOKEN/,
    ],
    description: 'securityFindingAwsCredentials',
  },
  {
    id: 'file_access.browser_data',
    dimension: 'file_access',
    severity: 'danger',
    filePatterns: ['**/*.sh', '**/*.js', '**/*.ts', '**/*.ps1'],
    patterns: [
      /Chrome\/User Data/i,
      /Firefox\/Profiles/i,
      /\.mozilla\/firefox/i,
      /Chromium\/Default/i,
      /Login Data|Cookies|Web Data/,
      /moz_cookies|moz_logins/i,
    ],
    description: 'securityFindingBrowserData',
  },
  {
    id: 'file_access.tokens_credentials',
    dimension: 'file_access',
    severity: 'danger',
    filePatterns: ['**/*.sh', '**/*.js', '**/*.ts', '**/*.ps1'],
    patterns: [
      /\.npmrc\b/,
      /\.netrc\b/,
      /\.pypirc\b/,
      /\.docker\/config\.json/,
      /\.kube\/config/,
      /\.gnupg\//,
      /gcloud.*credentials/i,
      /\.azure.*accessTokens/i,
    ],
    description: 'securityFindingTokenAccess',
  },
  {
    id: 'file_access.macos_keychain',
    dimension: 'file_access',
    severity: 'critical',
    filePatterns: ['**/*.sh', '**/*.bash', '**/*.js'],
    patterns: [
      /security\s+find-(generic|internet)-password/,
      /security\s+dump-keychain/,
    ],
    description: 'securityFindingKeychainAccess',
  },
  {
    id: 'file_access.env_secrets',
    dimension: 'file_access',
    severity: 'warning',
    filePatterns: ['**/*.sh', '**/*.js', '**/*.ts', '**/*.ps1'],
    patterns: [
      /process\.env\.(API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)/i,
      /\$\{?(API_KEY|SECRET_KEY|AUTH_TOKEN|DB_PASSWORD|PRIVATE_KEY)\}?/i,
    ],
    description: 'securityFindingEnvSecrets',
  },
];

// ── Dimension 2: Dangerous Commands ───────────────────────────────────────────

const DANGEROUS_COMMAND_RULES: SecurityRule[] = [
  {
    id: 'dangerous_cmd.rm_rf',
    dimension: 'dangerous_command',
    severity: 'danger',
    filePatterns: ['**/*.sh', '**/*.bash', '**/*.ps1', '**/*.bat', '**/*.cmd'],
    patterns: [
      /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\b/,
      /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r\b/,
      /\brm\s+--force\s+--recursive\b/,
      /\brm\s+--recursive\s+--force\b/,
      /\brmdir\s+\/[sS]\b/,
      /Remove-Item\s+.*-Recurse\s+-Force/i,
    ],
    description: 'securityFindingRmRf',
  },
  {
    id: 'dangerous_cmd.disk_format',
    dimension: 'dangerous_command',
    severity: 'critical',
    filePatterns: ['**/*.sh', '**/*.bash', '**/*.ps1', '**/*.bat', '**/*.cmd'],
    patterns: [
      /\bmkfs\b/,
      /\bformat\s+[a-zA-Z]:/i,
      /\bdd\s+.*of=\/dev\//,
      /\bdiskpart\b/i,
      /\bfdisk\b/,
    ],
    description: 'securityFindingDiskFormat',
  },
  {
    id: 'dangerous_cmd.sudo',
    dimension: 'dangerous_command',
    severity: 'danger',
    filePatterns: ['**/*.sh', '**/*.bash'],
    patterns: [
      /\bsudo\b/,
      /\bsu\s+-\b/,
      /\bpkexec\b/,
    ],
    description: 'securityFindingSudo',
  },
  {
    id: 'dangerous_cmd.destructive_git',
    dimension: 'dangerous_command',
    severity: 'warning',
    filePatterns: ['**/*.sh', '**/*.bash', '**/*.js', '**/*.ts'],
    patterns: [
      /git\s+push\s+--force\b/,
      /git\s+push\s+-f\b/,
      /git\s+reset\s+--hard\b/,
      /git\s+clean\s+-[a-zA-Z]*f/,
    ],
    description: 'securityFindingDestructiveGit',
  },
  {
    id: 'dangerous_cmd.system_modify',
    dimension: 'dangerous_command',
    severity: 'critical',
    filePatterns: ['**/*.sh', '**/*.bash', '**/*.ps1', '**/*.bat'],
    patterns: [
      /\bchmod\s+777\b/,
      /\bchown\s+-R\s+root/,
      /\/etc\/passwd/,
      /\/etc\/shadow/,
      /\biptables\b/,
      /\bsystemctl\s+(enable|start|stop|disable)/,
      /\blaunchctl\b/,
      /reg\s+add\b.*HKLM/i,
      /Set-ItemProperty.*HKLM/i,
    ],
    description: 'securityFindingSystemModify',
  },
  {
    id: 'dangerous_cmd.fork_bomb',
    dimension: 'dangerous_command',
    severity: 'critical',
    filePatterns: ['**/*.sh', '**/*.bash', '**/*.bat', '**/*.cmd'],
    patterns: [
      /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/,
      /%0\|%0/,
    ],
    description: 'securityFindingForkBomb',
  },
];

// ── Dimension 3: Network ──────────────────────────────────────────────────────

const NETWORK_RULES: SecurityRule[] = [
  {
    id: 'network.data_exfil_curl',
    dimension: 'network',
    severity: 'danger',
    filePatterns: ['**/*.sh', '**/*.bash'],
    patterns: [
      /curl\s+.*-[a-zA-Z]*d\s+.*(\$HOME|\$\(cat|\/etc\/|\.ssh|passwd)/,
      /curl\s+.*--data.*(\$HOME|\$\(cat|\.ssh|passwd)/,
      /wget\s+.*--post-data/,
    ],
    description: 'securityFindingDataExfil',
  },
  {
    id: 'network.data_exfil_fetch',
    dimension: 'network',
    severity: 'danger',
    filePatterns: ['**/*.js', '**/*.ts', '**/*.mjs'],
    patterns: [
      /https?:\/\/[^'"]*\.(tk|ml|ga|cf)\//,
      /ngrok\.io|serveo\.net|localtunnel\.me/,
      /pastebin\.com|paste\.ee|hastebin\.com/,
    ],
    description: 'securityFindingDataExfilJs',
  },
  {
    id: 'network.webhook_exfil',
    dimension: 'network',
    severity: 'warning',
    filePatterns: ['**/*.sh', '**/*.js', '**/*.ts', '**/*.ps1'],
    patterns: [
      /discord\.com\/api\/webhooks\//,
      /hooks\.slack\.com/,
      /api\.telegram\.org\/bot/,
    ],
    description: 'securityFindingWebhookExfil',
  },
  {
    id: 'network.dns_exfil',
    dimension: 'network',
    severity: 'critical',
    filePatterns: ['**/*.sh', '**/*.bash', '**/*.js'],
    patterns: [
      /\bnslookup\s+\$\(/,
      /\bdig\s+\$\(/,
      /\.burpcollaborator\.net/,
      /\.oastify\.com/,
      /\.interact\.sh/,
    ],
    description: 'securityFindingDnsExfil',
  },
  {
    id: 'network.encoded_url',
    dimension: 'network',
    severity: 'warning',
    filePatterns: ['**/*.js', '**/*.ts', '**/*.sh'],
    patterns: [
      /atob\s*\(\s*['"][A-Za-z0-9+/=]{20,}['"]\s*\)/,
      /Buffer\.from\s*\(\s*['"][A-Za-z0-9+/=]{20,}['"]\s*,\s*['"]base64['"]\s*\)/,
    ],
    description: 'securityFindingEncodedUrl',
  },
];

// ── Dimension 4: Process ──────────────────────────────────────────────────────

const PROCESS_RULES: SecurityRule[] = [
  {
    id: 'process.reverse_shell',
    dimension: 'process',
    severity: 'critical',
    filePatterns: ['**/*.sh', '**/*.bash', '**/*.js', '**/*.ts', '**/*.ps1'],
    patterns: [
      /\/dev\/tcp\//,
      /\bmkfifo\b/,
      /\bnc\s+.*-[a-zA-Z]*e\b/,
      /\bncat\b.*-[a-zA-Z]*e\b/,
      /\bsocat\b.*exec:/i,
      /child_process.*exec.*bash\s+-i/,
      /python\s+-c\s+['"]import\s+socket/,
      /New-Object\s+Net\.Sockets\.TcpClient/i,
    ],
    description: 'securityFindingReverseShell',
  },
  {
    id: 'process.crypto_miner',
    dimension: 'process',
    severity: 'critical',
    filePatterns: ['**/*.sh', '**/*.bash', '**/*.js', '**/*.ts'],
    patterns: [
      /\bxmrig\b/i,
      /\bminerd\b/i,
      /\bcgminer\b/i,
      /stratum\+tcp:\/\//,
      /cryptonight|randomx/i,
      /monero.*pool|pool.*monero/i,
    ],
    description: 'securityFindingCryptoMiner',
  },
  {
    id: 'process.background_daemon',
    dimension: 'process',
    severity: 'warning',
    filePatterns: ['**/*.sh', '**/*.bash', '**/*.ps1'],
    patterns: [
      /\bnohup\b.*&\s*$/m,
      /\bdisown\b/,
      /crontab\s+-[el]/,
      /Start-Process.*-WindowStyle\s+Hidden/i,
    ],
    description: 'securityFindingBackgroundProcess',
  },
];

// ── Dimension 5: Screen / Input ───────────────────────────────────────────────

const SCREEN_INPUT_RULES: SecurityRule[] = [
  {
    id: 'screen_input.screenshot',
    dimension: 'screen_input',
    severity: 'danger',
    filePatterns: ['**/*.sh', '**/*.bash', '**/*.js', '**/*.ts', '**/*.ps1'],
    patterns: [
      /\bscreencapture\b/,
      /\bscrot\b/,
      /\bgnome-screenshot\b/,
      /desktopCapturer/,
      /\[System\.Drawing\.Graphics\]::CopyFromScreen/i,
    ],
    description: 'securityFindingScreenshot',
  },
  {
    id: 'screen_input.keylogger',
    dimension: 'screen_input',
    severity: 'critical',
    filePatterns: ['**/*.js', '**/*.ts', '**/*.ps1'],
    patterns: [
      /\bkeylogger\b/i,
      /SetWindowsHookEx.*WH_KEYBOARD/i,
      /IOHIDManager/,
      /Add-Type.*user32.*GetAsyncKeyState/i,
    ],
    description: 'securityFindingKeylogger',
  },
  {
    id: 'screen_input.clipboard',
    dimension: 'screen_input',
    severity: 'warning',
    filePatterns: ['**/*.js', '**/*.ts', '**/*.sh', '**/*.ps1'],
    patterns: [
      /clipboard\.readText/,
      /\bpbpaste\b/,
      /\bxclip\b.*-o/,
      /\bxsel\b.*--output/,
      /Get-Clipboard/i,
    ],
    description: 'securityFindingClipboard',
  },
];

// ── Dimension 6: Payment ──────────────────────────────────────────────────────

const PAYMENT_RULES: SecurityRule[] = [
  {
    id: 'payment.payment_api',
    dimension: 'payment',
    severity: 'danger',
    filePatterns: ['**/*.js', '**/*.ts', '**/*.sh'],
    patterns: [
      /stripe\.com\/v1\/charges/i,
      /paypal\.com\/v[12]\/payments/i,
      /api\.alipay\.com/i,
      /api\.mch\.weixin\.qq\.com/i,
    ],
    description: 'securityFindingPaymentApi',
  },
  {
    id: 'payment.crypto_wallet',
    dimension: 'payment',
    severity: 'danger',
    filePatterns: ['**/*.js', '**/*.ts', '**/*.sh', '**/*.ps1'],
    patterns: [
      /wallet\.dat/i,
      /\bweb3\.eth\.sendTransaction\b/,
      /\bsolana.*transfer\b/i,
      /\bprivateKey\b.*\b0x[0-9a-f]{64}\b/i,
    ],
    description: 'securityFindingCryptoWallet',
  },
];

// ── Dimension 8: Web Content ──────────────────────────────────────────────────

const WEB_CONTENT_RULES: SecurityRule[] = [
  {
    id: 'web_content.inline_script',
    dimension: 'web_content',
    severity: 'warning',
    filePatterns: ['**/*.html', '**/*.htm'],
    patterns: [
      /<script[^>]*>[\s\S]*?(document\.cookie|localStorage|sessionStorage)/i,
      /on(load|error|click|mouseover)\s*=\s*["'].*?(eval|Function|setTimeout.*\()/i,
    ],
    description: 'securityFindingInlineScript',
  },
  {
    id: 'web_content.svg_script',
    dimension: 'web_content',
    severity: 'danger',
    filePatterns: ['**/*.svg'],
    patterns: [
      /<script\b/i,
      /on(load|error|click)\s*=/i,
      /<foreignObject\b/i,
      /javascript:/i,
    ],
    description: 'securityFindingSvgScript',
  },
  {
    id: 'web_content.external_resource',
    dimension: 'web_content',
    severity: 'warning',
    filePatterns: ['**/*.html', '**/*.htm'],
    patterns: [
      /<(script|iframe|object|embed)\s[^>]*src\s*=\s*["']https?:\/\//i,
    ],
    description: 'securityFindingExternalResource',
  },
];

// ── All Rules ─────────────────────────────────────────────────────────────────

export const ALL_SECURITY_RULES: SecurityRule[] = [
  ...FILE_ACCESS_RULES,
  ...DANGEROUS_COMMAND_RULES,
  ...NETWORK_RULES,
  ...PROCESS_RULES,
  ...SCREEN_INPUT_RULES,
  ...PAYMENT_RULES,
  ...WEB_CONTENT_RULES,
];

/**
 * Get rules that apply to a given file path based on glob patterns.
 * Uses simple suffix matching (not full glob) for performance.
 */
export function getRulesForFile(relativePath: string): SecurityRule[] {
  const ext = getExtension(relativePath);
  return ALL_SECURITY_RULES.filter(rule =>
    rule.filePatterns.some(pattern => matchesGlobSuffix(pattern, ext, relativePath))
  );
}

function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  return lastDot >= 0 ? filePath.substring(lastDot) : '';
}

function matchesGlobSuffix(pattern: string, ext: string, filePath: string): boolean {
  // Handle patterns like '**/*.sh' → match .sh extension
  const globExt = pattern.replace(/^\*\*\/\*/, '');
  if (globExt.startsWith('.')) {
    return ext === globExt;
  }
  // Handle patterns like '**/SKILL.md' → exact filename match
  const fileName = filePath.split(/[/\\]/).pop() || '';
  const patternName = pattern.replace(/^\*\*\//, '');
  return fileName === patternName;
}
