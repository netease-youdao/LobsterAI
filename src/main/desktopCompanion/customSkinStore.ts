import { createHash } from 'crypto';
import { app, nativeImage } from 'electron';
import fs from 'fs';
import path from 'path';

import { CompanionCustomSkin, type CompanionCustomSkinAsset, isCustomCompanionSkin } from '../../shared/desktopCompanion/customSkin';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Check the header before invoking the native decoder (no large decoded images). */
export function validateCompanionPng(buffer: Buffer): void {
  if (buffer.length > CompanionCustomSkin.MaxSavedBytes || buffer.length < 33
    || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)
    || buffer.toString('ascii', 12, 16) !== 'IHDR'
    || buffer.readUInt32BE(16) !== CompanionCustomSkin.OutputDimension
    || buffer.readUInt32BE(20) !== CompanionCustomSkin.OutputDimension) {
    throw new Error('Invalid companion image. A 512 × 512 PNG under 2 MB is required.');
  }
}

function skinDirectory(): string {
  return path.join(app.getPath('userData'), CompanionCustomSkin.Directory);
}

function verifyDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid companion image directory.');
}

export function loadCustomCompanionSkin(id: unknown): CompanionCustomSkinAsset | undefined {
  if (!isCustomCompanionSkin(id)) return undefined;
  try {
    const directory = skinDirectory();
    verifyDirectory(directory);
    const file = path.join(directory, `${id}.png`);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > CompanionCustomSkin.MaxSavedBytes) return undefined;
    const bytes = fs.readFileSync(file);
    validateCompanionPng(bytes);
    if (`${CompanionCustomSkin.IdPrefix}${createHash('sha256').update(bytes).digest('hex')}` !== id) return undefined;
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) return undefined;
    const displayed = image.toPNG();
    return { id, dataUrl: `data:image/png;base64,${displayed.toString('base64')}` };
  } catch {
    return undefined;
  }
}

/** Only remove a hash-named skin file owned by this profile. */
export function deleteCustomCompanionSkin(id: unknown): void {
  if (!isCustomCompanionSkin(id)) throw new Error('Invalid companion skin ID.');
  const directory = skinDirectory();
  try {
    verifyDirectory(directory);
    const file = path.join(directory, `${id}.png`);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid companion skin file.');
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function saveCustomCompanionSkin(value: unknown): CompanionCustomSkinAsset {
  const prefix = 'data:image/png;base64,';
  if (typeof value !== 'string' || !value.startsWith(prefix)
    || value.length > prefix.length + Math.ceil(CompanionCustomSkin.MaxSavedBytes / 3) * 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.slice(prefix.length))) throw new Error('Invalid companion image.');
  const bytes = Buffer.from(value.slice(prefix.length), 'base64');
  validateCompanionPng(bytes);
  const image = nativeImage.createFromBuffer(bytes);
  const size = image.getSize();
  if (image.isEmpty() || size.width !== CompanionCustomSkin.OutputDimension || size.height !== CompanionCustomSkin.OutputDimension) {
    throw new Error('Unable to decode companion image.');
  }
  const png = image.toPNG(); // Strip metadata and preserve alpha.
  validateCompanionPng(png);
  const id = `${CompanionCustomSkin.IdPrefix}${createHash('sha256').update(png).digest('hex')}`;
  const directory = skinDirectory();
  fs.mkdirSync(directory, { recursive: true });
  verifyDirectory(directory);
  const file = path.join(directory, `${id}.png`);
  try { fs.writeFileSync(file, png, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !loadCustomCompanionSkin(id)) throw error;
  }
  return { id, dataUrl: `data:image/png;base64,${png.toString('base64')}` };
}
