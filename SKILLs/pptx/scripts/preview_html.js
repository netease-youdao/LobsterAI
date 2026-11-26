#!/usr/bin/env node
'use strict';

/**
 * Headless HTML slide visual preview & overflow checker for LobsterAI PPTX skill.
 *
 * Uses Playwright (headless Chromium) + Sharp already bundled under SKILLs/pptx/node_modules.
 * Produces zero desktop windows, requires no LibreOffice/Keynote/WPS, and renders a
 * 12-slide deck into crisp numbered thumbnail grids in ~1-2 seconds.
 *
 * Usage:
 *   node preview_html.js <html-dir-or-files...> --out <preview.jpg> [--cols 3] [--max-per-grid 9] [--slides-dir <dir>]
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const sharp = require('sharp');

const DEFAULT_COLS = 3;
const DEFAULT_MAX_PER_GRID = 9;
const TILE_WIDTH = 480;
const LABEL_HEIGHT = 28;
const PADDING = 16;
const GAP = 14;

function parseArgs(argv) {
  const inputs = [];
  let outPath = '';
  let cols = DEFAULT_COLS;
  let maxPerGrid = DEFAULT_MAX_PER_GRID;
  let slidesDir = '';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out' || arg === '-o') {
      outPath = argv[++i] || '';
    } else if (arg === '--cols') {
      cols = Math.max(1, Math.min(6, Number(argv[++i]) || DEFAULT_COLS));
    } else if (arg === '--max-per-grid') {
      maxPerGrid = Math.max(1, Math.min(16, Number(argv[++i]) || DEFAULT_MAX_PER_GRID));
    } else if (arg === '--slides-dir') {
      slidesDir = argv[++i] || '';
    } else if (!arg.startsWith('-')) {
      inputs.push(arg);
    }
  }

  return { inputs, outPath, cols, maxPerGrid, slidesDir };
}

function naturalCompare(a, b) {
  return path.basename(a).localeCompare(path.basename(b), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function collectHtmlFiles(inputs) {
  const files = [];
  for (const input of inputs) {
    const resolved = path.resolve(input);
    if (!fs.existsSync(resolved)) {
      throw new Error(`输入路径不存在: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolved)
        .filter((name) => /\.html?$/i.test(name))
        .map((name) => path.join(resolved, name))
        .sort(naturalCompare);
      files.push(...entries);
    } else if (/\.html?$/i.test(resolved)) {
      files.push(resolved);
    }
  }
  return files;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function launchHeadlessBrowser() {
  const baseOptions = { headless: true };
  if (process.platform === 'darwin') {
    try {
      return await chromium.launch({ ...baseOptions, channel: 'chrome' });
    } catch {
      // Fall back to bundled Playwright Chromium when system Chrome is absent.
    }
  }
  return chromium.launch(baseOptions);
}

function buildLabelSvg(width, height, text, hasOverflow) {
  const bg = hasOverflow ? '#B91C1C' : '#1E293B';
  const safeText = escapeXml(text.slice(0, 48));
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<rect width="${width}" height="${height}" fill="${bg}"/>`
    + `<text x="10" y="19" fill="#FFFFFF" font-family="PingFang SC, Microsoft YaHei, Arial, sans-serif" font-size="13" font-weight="600">${safeText}</text>`
    + `</svg>`,
  );
}

async function composeGrid(tiles, cols, outputPath) {
  if (tiles.length === 0) return;
  const tileW = tiles[0].tileW;
  const tileH = tiles[0].tileH;
  const cellH = tileH + LABEL_HEIGHT;
  const actualCols = Math.min(cols, tiles.length);
  const rows = Math.ceil(tiles.length / actualCols);

  const canvasW = PADDING * 2 + actualCols * tileW + (actualCols - 1) * GAP;
  const canvasH = PADDING * 2 + rows * cellH + (rows - 1) * GAP;

  const composites = [];
  for (let idx = 0; idx < tiles.length; idx += 1) {
    const tile = tiles[idx];
    const col = idx % actualCols;
    const row = Math.floor(idx / actualCols);
    const left = PADDING + col * (tileW + GAP);
    const top = PADDING + row * (cellH + GAP);

    const labelText = `${String(tile.index).padStart(2, '0')} ${tile.name}${tile.overflow ? ' [溢出]' : ''}`;
    composites.push({
      input: buildLabelSvg(tileW, LABEL_HEIGHT, labelText, Boolean(tile.overflow)),
      left,
      top,
    });
    composites.push({
      input: tile.thumbBuffer,
      left,
      top: top + LABEL_HEIGHT,
    });
  }

  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  await sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 3,
      background: { r: 238, g: 240, b: 244 },
    },
  })
    .composite(composites)
    .jpeg({ quality: 88 })
    .toFile(outputPath);
}

async function main() {
  const { inputs, outPath, cols, maxPerGrid, slidesDir } = parseArgs(process.argv.slice(2));
  if (inputs.length === 0) {
    console.error('用法: node preview_html.js <html目录或文件...> --out <preview.jpg> [--cols 3] [--max-per-grid 9] [--slides-dir <dir>]');
    process.exit(1);
  }

  const htmlFiles = collectHtmlFiles(inputs);
  if (htmlFiles.length === 0) {
    console.error('未找到任何 .html 幻灯片文件。');
    process.exit(1);
  }

  const targetOut = path.resolve(outPath || path.join(path.dirname(htmlFiles[0]), 'slides-preview.jpg'));
  if (slidesDir) {
    fs.mkdirSync(path.resolve(slidesDir), { recursive: true });
  }

  const browser = await launchHeadlessBrowser();
  const rendered = [];
  const overflows = [];

  try {
    const context = await browser.newContext({
      viewport: { width: 960, height: 540 },
      deviceScaleFactor: 1.5,
    });
    const page = await context.newPage();

    for (let i = 0; i < htmlFiles.length; i += 1) {
      const file = htmlFiles[i];
      const name = path.basename(file);
      const url = pathToFileURL(file).href;

      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 8000 });
      } catch {
        await page.goto(url, { waitUntil: 'load', timeout: 8000 });
      }

      const metrics = await page.evaluate(() => {
        const body = document.body;
        const rect = body.getBoundingClientRect();
        const width = Math.max(320, Math.round(rect.width || 960));
        const height = Math.max(180, Math.round(rect.height || 540));
        return {
          width,
          height,
          scrollWidth: Math.round(body.scrollWidth),
          scrollHeight: Math.round(body.scrollHeight),
          clientWidth: Math.round(body.clientWidth),
          clientHeight: Math.round(body.clientHeight),
        };
      });

      await page.setViewportSize({ width: metrics.width, height: metrics.height });
      const overflowX = Math.max(0, metrics.scrollWidth - metrics.clientWidth);
      const overflowY = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
      const hasOverflow = overflowX > 2 || overflowY > 2;

      const rawPng = await page.screenshot({ type: 'png' });
      const tileH = Math.round((TILE_WIDTH * metrics.height) / metrics.width);
      const thumbBuffer = await sharp(rawPng)
        .resize(TILE_WIDTH, tileH, { fit: 'fill' })
        .png()
        .toBuffer();

      let slideImagePath = null;
      if (slidesDir) {
        slideImagePath = path.resolve(slidesDir, `${name.replace(/\.html?$/i, '')}.jpg`);
        await sharp(rawPng).jpeg({ quality: 90 }).toFile(slideImagePath);
      }

      if (hasOverflow) {
        overflows.push({
          index: i + 1,
          file: name,
          overflowX,
          overflowY,
        });
      }

      rendered.push({
        index: i + 1,
        name,
        width: metrics.width,
        height: metrics.height,
        overflow: hasOverflow ? { overflowX, overflowY } : null,
        slideImagePath,
        tileW: TILE_WIDTH,
        tileH,
        thumbBuffer,
      });
    }

    await context.close();
  } finally {
    await browser.close();
  }

  const grids = [];
  const totalGrids = Math.ceil(rendered.length / maxPerGrid);
  const parsedOut = path.parse(targetOut);

  for (let g = 0; g < totalGrids; g += 1) {
    const chunk = rendered.slice(g * maxPerGrid, (g + 1) * maxPerGrid);
    const gridPath = totalGrids === 1
      ? targetOut
      : path.join(parsedOut.dir, `${parsedOut.name}-${g + 1}${parsedOut.ext || '.jpg'}`);
    await composeGrid(chunk, cols, gridPath);
    grids.push(gridPath);
  }

  console.log(JSON.stringify({
    ok: true,
    slideCount: rendered.length,
    grids,
    overflows,
    slides: rendered.map((s) => ({
      index: s.index,
      name: s.name,
      size: `${s.width}x${s.height}`,
      overflow: s.overflow,
      ...(s.slideImagePath ? { image: s.slideImagePath } : {}),
    })),
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
