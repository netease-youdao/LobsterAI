import { describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: {} }));

import { isLockFileOf } from './officeFileHandlers';

describe('lock files of an open document', () => {
  test('Excel, PowerPoint and WPS prefix the whole name', () => {
    expect(isLockFileOf('~$年包积分按月发放-测试用例.xlsx', '年包积分按月发放-测试用例.xlsx')).toBe(true);
    expect(isLockFileOf('~$deck.pptx', 'deck.pptx')).toBe(true);
  });

  test('Word drops up to two leading characters of long names', () => {
    expect(isLockFileOf('~$cument1.docx', 'document1.docx')).toBe(true);
    expect(isLockFileOf('~$ocument1.docx', 'document1.docx')).toBe(true);
    expect(isLockFileOf('~$ment1.docx', 'document1.docx')).toBe(false);
  });

  test('LibreOffice marks the document with its own lock file', () => {
    expect(isLockFileOf('.~lock.report.xlsx#', 'report.xlsx')).toBe(true);
  });

  test('other files next to the document are not its lock files', () => {
    expect(isLockFileOf('~$other.xlsx', 'report.xlsx')).toBe(false);
    expect(isLockFileOf('.report.xlsx.0b1c.tmp', 'report.xlsx')).toBe(false);
    expect(isLockFileOf('report.xlsx', 'report.xlsx')).toBe(false);
  });
});
