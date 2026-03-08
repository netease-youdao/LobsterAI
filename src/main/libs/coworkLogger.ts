import { app } from 'electron';
import fs from 'fs';
import path from 'path';

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

let logFilePath: string | null = null;

function getLogFilePath(): string {
  if (!logFilePath) {
    const logDir = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    logFilePath = path.join(logDir, 'cowork.log');
  }
  return logFilePath;
}

function rotateIfNeeded(): void {
  try {
    const filePath = getLogFilePath();
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_LOG_SIZE) {
      const backupPath = filePath + '.old';
      if (fs.existsSync(backupPath)) {
        fs.unlinkSync(backupPath);
      }
      fs.renameSync(filePath, backupPath);
    }
  } catch {
    // ignore rotation errors
  }
}

function formatTimestamp(): string {
  const date = new Date();
  const pad = (value: number, length = 2): string => value.toString().padStart(length, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());
  const millisecond = pad(date.getMilliseconds(), 3);

  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutes);
  const offsetHour = pad(Math.floor(absOffset / 60));
  const offsetMinute = pad(absOffset % 60);

  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}${sign}${offsetHour}:${offsetMinute}`;
}

export function coworkLog(level: 'INFO' | 'WARN' | 'ERROR', tag: string, message: string, extra?: Record<string, unknown>): void {
  try {
    rotateIfNeeded();
    const parts = [`[${formatTimestamp()}] [${level}] [${tag}] ${message}`];
    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        parts.push(`  ${key}: ${serialized}`);
      }
    }
    parts.push('');
    fs.appendFileSync(getLogFilePath(), parts.join('\n'), 'utf-8');
  } catch {
    // Logging should never throw
  }
}

export function getCoworkLogPath(): string {
  return getLogFilePath();
}
