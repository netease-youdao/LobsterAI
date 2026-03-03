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

export async function exportLogsZip(input: ExportLogsZipInput): Promise<ExportLogsZipResult> {
  const zipFile = new yazl.ZipFile();
  const missingEntries: string[] = [];

  for (const entry of input.entries) {
    if (fs.existsSync(entry.filePath) && fs.statSync(entry.filePath).isFile()) {
      zipFile.addFile(entry.filePath, entry.archiveName);
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
