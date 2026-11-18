/** Electron bitmaps use premultiplied BGRA. Multiply color and alpha together. */
export function applyForegroundMatte(source: Uint8Array, matte: Uint8Array, width: number): Uint8Array {
  const pixels = matte.length / 4;
  if (source.length !== matte.length || source.length % 4 !== 0
    || !Number.isInteger(width) || width < 1 || pixels % width !== 0) throw new Error('Image matte dimensions differ');
  const output = new Uint8Array(source);
  const alpha = new Uint8Array(pixels);
  let dark = 0;
  let light = 0;
  let colored = 0;
  for (let i = 0; i < matte.length; i += 4) {
    const low = Math.min(matte[i], matte[i + 1], matte[i + 2]);
    const high = Math.max(matte[i], matte[i + 1], matte[i + 2]);
    if (high - low > 40) colored++;
    const luminance = 0.0722 * matte[i] + 0.7152 * matte[i + 1] + 0.2126 * matte[i + 2];
    if (luminance < 24) dark++;
    if (luminance > 231) light++;
    // Generative mattes contain faint texture in nominally black/white areas.
    // Snap these tails while retaining a smooth transition at subject edges.
    alpha[i / 4] = Math.round(255 * Math.min(1, Math.max(0, (luminance - 32) / 191)));
  }
  if (!pixels || dark / pixels < 0.005 || light / pixels < 0.005 || colored / pixels > 0.02) {
    throw new Error('imageEditMaskInvalid');
  }
  // The requested matte is binary with antialiased edges. Keep soft pixels near
  // confident foreground, but discard detached low-confidence background lines.
  const height = pixels / width;
  const feather = Math.max(2, Math.min(8, Math.ceil(Math.max(width, height) / 512)));
  const distance = new Uint8Array(pixels).fill(feather + 1);
  for (let p = 0; p < pixels; p++) {
    if (alpha[p] >= 128) { distance[p] = 0; continue; }
    const x = p % width;
    if (x > 0) distance[p] = Math.min(distance[p], distance[p - 1] + 1);
    if (p >= width) {
      distance[p] = Math.min(distance[p], distance[p - width] + 1);
      if (x > 0) distance[p] = Math.min(distance[p], distance[p - width - 1] + 1);
      if (x + 1 < width) distance[p] = Math.min(distance[p], distance[p - width + 1] + 1);
    }
  }
  for (let p = pixels - 1; p >= 0; p--) {
    const x = p % width;
    if (x + 1 < width) distance[p] = Math.min(distance[p], distance[p + 1] + 1);
    if (p + width < pixels) {
      distance[p] = Math.min(distance[p], distance[p + width] + 1);
      if (x > 0) distance[p] = Math.min(distance[p], distance[p + width - 1] + 1);
      if (x + 1 < width) distance[p] = Math.min(distance[p], distance[p + width + 1] + 1);
    }
    const opacity = distance[p] <= feather ? alpha[p] / 255 : 0;
    for (let channel = 0; channel < 4; channel++) output[p * 4 + channel] = Math.round(source[p * 4 + channel] * opacity);
  }
  return output;
}
