import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

// The complete templates shipped in SKILLs/skin-creator before it became kit-owned.
// Hash both Markdown files in order, with LF line endings and a NUL after each.
const legacyTemplateDigests = new Set([
  '9fe5f8d7e6ddec28fde24882f235c09df75854d8caf9c291a68c0857ac19f8c7', // ddc8b502a
  '50551a22c3b4fb8b9a8f590caf38427f720b88dbb323eb19d48a03e2496f8218', // d7afc8519
  '0ec6b389d2ceee1438016399c87f843aaf9acedc3a16e2cd1aacd896edb25e21', // 3bf9d1a38
  '5949761bb0ac626923ef1936b80e22e3a3ed6fd9886bc05664bc8aa0b378f265', // a6375a66b
  '45b23a89339af8a863e5854ea97fda0d9d7d2edb74c7ab7c8a68bb5303148ab8', // cf39233ba
  '212f4f66d5cfd44803f0afcab01b58945b1dc1142bf656dbbda4ef00a4260177', // fb0202c88
  '4993ee4068d03c6181724684160082c88335964c2e47bdaf9f6922c656aa0a1c', // f1a97efab
]);

function templateDigest(dir: string): string | undefined {
  if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (!entries.some(entry => entry.name === 'SKILL.md' && entry.isFile())) return;
  const files = [path.join(dir, 'SKILL.md')];
  if (entries.length !== 1) {
    if (entries.length !== 2 || !entries.some(entry => entry.name === 'references' && entry.isDirectory())) return;
    const references = path.join(dir, 'references');
    const assets = fs.readdirSync(references, { withFileTypes: true });
    if (assets.length !== 1 || assets[0].name !== 'asset-contract.md' || !assets[0].isFile()) return;
    files.push(path.join(references, assets[0].name));
  }
  const hash = createHash('sha256');
  for (const file of files) {
    // All shipped template files are under 12 KiB. Leave larger user files alone.
    if (fs.statSync(file).size > 64 * 1024) return;
    hash.update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).update('\0');
  }
  return hash.digest('hex');
}

/** Only an unmodified shipped tree can be discarded without an installed kit record. */
export function isShippedSkinCreatorCopy(dir: string, bundledSource: string | null): boolean {
  const digest = templateDigest(dir);
  return digest !== undefined && (legacyTemplateDigests.has(digest)
    || (bundledSource !== null && digest === templateDigest(bundledSource)));
}
