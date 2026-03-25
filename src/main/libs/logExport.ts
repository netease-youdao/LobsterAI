import fs from 'fs';
import { pipeline } from 'stream/promises';
import yazl from 'yazl';

export type LogArchiveEntry = {
  archiveName: string;
  filePath: string;
};

export type ExportLogsZipInput = {
  outputPath: string;
  entries: LogArchiveEntry[];
};

export type ExportLogsZipResult = {
  missingEntries: string[];
};

/**
 * Patterns for sensitive data that should be masked in exported logs.
 * Each pattern includes a regex to match the sensitive value and a replacement string.
 */
const SENSITIVE_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  // API Keys - various formats
  {
    name: 'apiKey',
    pattern: /"(apiKey|api_key|api-key)"\s*:\s*"([^"]{8,})"/gi,
    replacement: '"$1": "***"',
  },
  // Bearer tokens in Authorization headers
  {
    name: 'bearerToken',
    pattern: /(Authorization:\s*Bearer\s+)([a-zA-Z0-9_\-\.]{20,})/gi,
    replacement: '$1***',
  },
  // x-api-key headers
  {
    name: 'xApiKey',
    pattern: /(x-api-key:\s*)([a-zA-Z0-9_\-\.]{8,})/gi,
    replacement: '$1***',
  },
  // Access tokens
  {
    name: 'accessToken',
    pattern: /"(accessToken|access_token|accessToken)"\s*:\s*"([^"]{8,})"/gi,
    replacement: '"$1": "***"',
  },
  // Refresh tokens
  {
    name: 'refreshToken',
    pattern: /"(refreshToken|refresh_token)"\s*:\s*"([^"]{8,})"/gi,
    replacement: '"$1": "***"',
  },
  // Generic tokens
  {
    name: 'token',
    pattern: /"(token)"\s*:\s*"([^"]{16,})"/gi,
    replacement: '"$1": "***"',
  },
  // Secrets
  {
    name: 'secret',
    pattern: /"(secret|appSecret|clientSecret|app_secret|client_secret)"\s*:\s*"([^"]{8,})"/gi,
    replacement: '"$1": "***"',
  },
  // Passwords
  {
    name: 'password',
    pattern: /"(password|passwd)"\s*:\s*"([^"]*)"/gi,
    replacement: '"$1": "***"',
  },
  // OpenClaw gateway token in args
  {
    name: 'gatewayToken',
    pattern: /(--token\s+)([a-zA-Z0-9_\-\.]{8,})/gi,
    replacement: '$1***',
  },
  // Turn tokens (format: turnId:token or similar)
  {
    name: 'turnToken',
    pattern: /(turnToken['"]?\s*[:=]\s*['"]?)([a-zA-Z0-9_\-]{8,})/gi,
    replacement: '$1***',
  },
];

/**
 * Mask sensitive data in log content.
 * This function scans the log content and replaces sensitive values with '***'.
 */
function maskSensitiveData(content: string): string {
  let masked = content;
  for (const { name, pattern, replacement } of SENSITIVE_PATTERNS) {
    try {
      masked = masked.replace(pattern, replacement);
    } catch (error) {
      // If a specific pattern fails, continue with others
      console.warn(`[LogExport] Failed to apply pattern ${name}:`, error);
    }
  }
  return masked;
}

/**
 * Check if a file should be processed for masking.
 * Only text-based log files should be processed, not binary files.
 */
function shouldMaskContent(filePath: string): boolean {
  const maskableExtensions = ['.log', '.txt', '.json'];
  const ext = filePath.toLowerCase().slice(filePath.lastIndexOf('.'));
  return maskableExtensions.includes(ext) || filePath.includes('.log');
}

export async function exportLogsZip(input: ExportLogsZipInput): Promise<ExportLogsZipResult> {
  const zipFile = new yazl.ZipFile();
  const missingEntries: string[] = [];

  for (const entry of input.entries) {
    if (fs.existsSync(entry.filePath) && fs.statSync(entry.filePath).isFile()) {
      // Check if this file needs content masking
      if (shouldMaskContent(entry.filePath)) {
        try {
          const content = fs.readFileSync(entry.filePath, 'utf8');
          const maskedContent = maskSensitiveData(content);
          zipFile.addBuffer(Buffer.from(maskedContent, 'utf8'), entry.archiveName);
        } catch (error) {
          // If masking fails, add empty placeholder
          console.warn(`[LogExport] Failed to mask content for ${entry.archiveName}:`, error);
          missingEntries.push(entry.archiveName);
          zipFile.addBuffer(Buffer.alloc(0), entry.archiveName);
        }
      } else {
        // For non-log files, add directly without masking
        zipFile.addFile(entry.filePath, entry.archiveName);
      }
      continue;
    }
    missingEntries.push(entry.archiveName);
    zipFile.addBuffer(Buffer.alloc(0), entry.archiveName);
  }

  const outputStream = fs.createWriteStream(input.outputPath);
  const pipelinePromise = pipeline(zipFile.outputStream, outputStream);
  zipFile.end();
  await pipelinePromise;

  return { missingEntries };
}
