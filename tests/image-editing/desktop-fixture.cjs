// Run with Electron after compile:electron. Uses only the dedicated retained acceptance profile.
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

if (process.env.IMAGE_EDITING_DATABASE_TEST !== 'true') throw new Error('Explicit test opt-in required');
const root = path.resolve(__dirname, '../..');
const evidence = path.resolve(process.env.IMAGE_EDITING_EVIDENCE_DIR || 'D:/project/lobsterai-server/build/image-editing-acceptance');
const profile = path.resolve(process.env.IMAGE_EDITING_DESKTOP_PROFILE || path.join(evidence, 'desktop-profile'));
const output = path.join(evidence, 'desktop-workspace');
fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(output, { recursive: true });
app.setPath('userData', profile);

app.whenReady().then(async () => {
  const { SqliteStore } = require(path.join(root, 'dist-electron/main/sqliteStore.js'));
  const { CoworkStore } = require(path.join(root, 'dist-electron/main/coworkStore.js'));
  const { ImageEditingService } = require(path.join(root, 'dist-electron/main/libs/imageEditing.js'));
  const { ImageEditOperation } = require(path.join(root, 'dist-electron/shared/imageEditing/types.js'));
  const credentials = JSON.parse(fs.readFileSync(path.join(evidence, 'session.private.json'), 'utf8'));
  assert.ok(credentials.user.yid.startsWith('image-editing-acceptance-'));
  const kv = await SqliteStore.create(profile);
  kv.set('auth_tokens', { accessToken: credentials.accessToken, refreshToken: credentials.refreshToken });
  kv.set('auth_user', { ...credentials.user, userId: credentials.user.id });
  kv.set('app_config', { language: 'zh', theme: 'light', app: { testMode: true }, hasAcceptedAgreement: true });
  kv.set(`media_preferences.v1:personal:${credentials.user.id}`, { schemaVersion: 1, revision: 1,
    image: { mode: 'selected', modelId: 'doubao-seedream-5-0-260128', modelName: 'Doubao-Seedream-5.0-lite' }, video: { mode: 'off' } });
  const cowork = new CoworkStore(kv.getDatabase());
  const session = cowork.createSession('图片编辑验收 · 20261019', output);
  const publish = version => cowork.addMessage(session.id, { type: 'system', content: `[${version.title}](${pathToFileURL(version.filePath)})`,
    metadata: { toolResultDetails: { assets: [{ type: 'image', filePath: version.filePath, filename: version.title }] } } });
  const imageEditor = new ImageEditingService({ directory: path.join(profile, 'image-editing'),
    getCwd: id => cowork.getSession(id)?.cwd, get: key => kv.get(key), set: (key, value) => kv.set(key, value), changed: () => {}, publish });
  const originalPath = path.join(output, 'cup-original.png'); fs.copyFileSync(path.join(evidence, 'source.png'), originalPath);
  const source = await imageEditor.open({ sessionId: session.id, title: 'cup-original.png', filePath: originalPath });
  publish({ ...source.version, filePath: originalPath });
  const results = [];
  for (const [name, operation] of [['comment', ImageEditOperation.Comment], ['background', ImageEditOperation.RemoveBackground], ['erase', ImageEditOperation.Erase], ['reframe', ImageEditOperation.Reframe]]) {
    const stage = await imageEditor.stage({ sessionId: session.id, sourceId: source.version.id, operation,
      regions: operation === ImageEditOperation.Comment ? [{ id: 'cup', x: .29, y: .37, width: .53, height: .46, text: '把杯子改成浅蓝色' }] : [],
      guideDataUrl: operation === ImageEditOperation.Erase ? `data:image/png;base64,${fs.readFileSync(path.join(evidence, 'erase-mask.png')).toString('base64')}` : undefined,
      aspectRatio: operation === ImageEditOperation.Reframe ? '16:9' : undefined });
    const task = JSON.parse(fs.readFileSync(path.join(evidence, `${name}-task.json`), 'utf8')).data;
    const raw = path.join(evidence, `${name}.png`);
    const incoming = operation === ImageEditOperation.RemoveBackground ? raw : path.join(output, `${name}.png`);
    if (incoming !== raw) fs.copyFileSync(raw, incoming);
    const asset = { type: 'image', url: task.resultUrls[0], originalUrl: task.resultUrls[0], filename: `${name}.png`,
      filePath: incoming, localPath: incoming, mimeType: 'image/png', outputIndex: 0 };
    const [result] = await imageEditor.finalize(stage, String(task.taskId), [asset]);
    const repeated = await imageEditor.finalize(stage, String(task.taskId), [asset]);
    assert.equal(repeated[0].filePath, result.filePath, 'finalization must be idempotent');
    const version = imageEditor.list({ sessionId: session.id, rootId: source.version.id }).find(v => v.requestId === stage.id);
    publish(version);
    const image = nativeImage.createFromPath(result.filePath); const size = image.getSize();
    const bitmap = image.toBitmap(); let transparent = 0, opaque = 0;
    for (let offset = 3; offset < bitmap.length; offset += 4) { if (bitmap[offset] === 0) transparent++; if (bitmap[offset] === 255) opaque++; }
    const pixels = bitmap.length / 4;
    const metrics = { name, taskId: task.taskId, filePath: result.filePath, ...size, transparentFraction: transparent / pixels, opaqueFraction: opaque / pixels };
    if (operation === ImageEditOperation.RemoveBackground) {
      assert.ok(metrics.transparentFraction > 0.3); assert.ok(metrics.opaqueFraction > 0.05);
      assert.equal(size.width, source.version.width); assert.equal(size.height, source.version.height);
      metrics.cupInteriorAlpha = bitmap[(Math.floor(size.height * .403) * size.width + Math.floor(size.width * .48)) * 4 + 3];
      metrics.handleHoleAlpha = bitmap[(Math.floor(size.height * .61) * size.width + Math.floor(size.width * .72)) * 4 + 3];
      metrics.backgroundLineAlpha = bitmap[(Math.floor(size.height * .615) * size.width + Math.floor(size.width * .15)) * 4 + 3];
      assert.equal(metrics.cupInteriorAlpha, 255);
      assert.equal(metrics.handleHoleAlpha, 0);
      assert.equal(metrics.backgroundLineAlpha, 0);
      const originalBitmap = nativeImage.createFromPath(originalPath).toBitmap(); let maxColorDifference = 0;
      for (let offset = 0; offset < bitmap.length; offset += 4) if (bitmap[offset + 3] === 255) {
        for (let color = 0; color < 3; color++) maxColorDifference = Math.max(maxColorDifference, Math.abs(bitmap[offset + color] - originalBitmap[offset + color]));
      }
      metrics.opaqueColorDifference = maxColorDifference; assert.equal(maxColorDifference, 0);
    }
    if (operation === ImageEditOperation.Reframe) assert.ok(Math.abs(size.width / size.height - 16 / 9) < 0.02);
    results.push(metrics);
  }
  const resized = await imageEditor.save({ sessionId: session.id, sourceId: source.version.id, operation: ImageEditOperation.Resize,
    dataUrl: nativeImage.createFromPath(originalPath).resize({ width: 800, height: 800 }).toDataURL() });
  assert.equal(resized.width, 800); assert.equal(resized.height, 800);
  const metadata = { sessionId: session.id, userId: credentials.user.id, profile, output, sourceId: source.version.id, results };
  fs.writeFileSync(path.join(evidence, 'desktop-evidence.json'), JSON.stringify(metadata, null, 2));
  kv.close(); console.log(JSON.stringify({ sessionId: session.id, results }, null, 2)); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
