// Opt-in real-provider acceptance. Credentials remain in the server's ignored build directory.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { buildSync } = require('esbuild');
const Module = require('node:module');

if (process.env.IMAGE_EDITING_DATABASE_TEST !== 'true') throw new Error('Explicit test opt-in required');
const directory = path.resolve(process.env.IMAGE_EDITING_EVIDENCE_DIR || 'D:/project/lobsterai-server/build/image-editing-acceptance');
const credentials = JSON.parse(fs.readFileSync(path.join(directory, 'session.private.json'), 'utf8'));
if (!credentials.user.yid.startsWith('image-editing-acceptance-')) throw new Error('Not the isolated test identity');
const bundled = buildSync({ stdin: { contents: "export * from './src/shared/imageEditing/prompts'; export * from './src/shared/imageEditing/geometry';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false });
const helpers = new Module('image-editing-acceptance'); helpers._compile(bundled.outputFiles[0].text, __filename);
const { imageEditPrompt, imageGenerationSize } = helpers.exports;
const headers = { Authorization: `Bearer ${credentials.accessToken}`, 'Content-Type': 'application/json' };
const base = 'http://127.0.0.1:18919/api/media/v2/tasks';
const write = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2));

function pngMask(width, height) {
  const crc = data => {
    let value = 0xffffffff;
    for (const byte of data) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(body)); return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = Math.floor(height * 0.37); y < height * 0.83; y++) {
    for (let x = Math.floor(width * 0.29); x < width * 0.82; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3; raw.fill(255, offset, offset + 3);
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  const sourceBytes = fs.readFileSync(path.join(directory, 'source.png'));
  const width = sourceBytes.readUInt32BE(16), height = sourceBytes.readUInt32BE(20);
  const source = { id: 'acceptance-source', rootId: 'acceptance-source', width, height };
  const mask = pngMask(width, height); fs.writeFileSync(path.join(directory, 'erase-mask.png'), mask);
  const cases = [
    { name: 'comment', operation: 'comment', regions: [{ id: 'cup', x: 0.29, y: 0.37, width: 0.53, height: 0.46, text: 'Change only the ceramic mug to pale blue; keep the wall, table, lighting and composition unchanged.' }] },
    { name: 'background', operation: 'remove-background', regions: [] },
    { name: 'erase', operation: 'erase', regions: [], guidePath: 'erase-mask.png' },
    { name: 'reframe', operation: 'reframe', regions: [], aspectRatio: '16:9' },
  ].filter(test => !process.env.IMAGE_EDITING_CASES || process.env.IMAGE_EDITING_CASES.split(',').includes(test.name));
  for (const test of cases) {
    const model = 'doubao-seedream-5-0-260128';
    const request = { mediaType: 'image', type: 'image', model, prompt: imageEditPrompt({ ...test, source }),
      params: { size: imageGenerationSize(width, height, test.aspectRatio), n: 1, output_format: 'png', watermark: false,
        images: [`data:image/png;base64,${sourceBytes.toString('base64')}`, ...(test.guidePath ? [`data:image/png;base64,${mask.toString('base64')}`] : [])] } };
    write(`${test.name}-request.json`, request);
    const requestHash = crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 16);
    const response = await fetch(base, { method: 'POST', headers: { ...headers, 'Idempotency-Key': `image-editing-${test.name}-${requestHash}` }, body: JSON.stringify(request), signal: AbortSignal.timeout(30000) });
    const body = await response.json(); write(`${test.name}-submission.json`, body);
    if (body.code !== 0) throw new Error(`${test.name}: ${body.message}`);
    test.taskId = body.data.taskId;
    console.log(`${test.name} task=${test.taskId} submitted`);
  }
  for (const test of cases) {
    let completed = false;
    for (let count = 0; count < 90; count++) {
      const response = await fetch(`${base}/${test.taskId}`, { headers, signal: AbortSignal.timeout(30000) });
      const body = await response.json(); write(`${test.name}-task.json`, body);
      if (body.code !== 0) throw new Error(`${test.name}: ${body.message}`);
      if (['succeeded', 'failed', 'cancelled', 'timeout'].includes(body.data.status)) {
        console.log(`${test.name} task=${test.taskId} status=${body.data.status}`);
        if (body.data.status !== 'succeeded') throw new Error(`${test.name}: model task ${body.data.status}`);
        const result = await fetch(body.data.resultUrls[0], { signal: AbortSignal.timeout(60000) });
        if (!result.ok) throw new Error(`${test.name}: result download ${result.status}`);
        fs.writeFileSync(path.join(directory, `${test.name}.png`), Buffer.from(await result.arrayBuffer()));
        completed = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    if (!completed) throw new Error(`${test.name}: timed out waiting for retained task ${test.taskId}`);
  }
  write('cases.json', { at: new Date().toISOString(), userId: credentials.user.id, cases });
})().catch(error => { console.error(error.message); process.exitCode = 1; });
