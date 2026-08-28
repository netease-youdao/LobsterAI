/**
 * Unit tests for dingtalkMediaParser.ts
 *
 * Covers:
 *   - parseMediaMarkers: Markdown image syntax ![alt](path)
 *   - parseMediaMarkers: Markdown link syntax [text](path) with media extensions
 *   - parseMediaMarkers: bare image paths on their own line
 *   - parseMediaMarkers: bare audio/video paths
 *   - parseMediaMarkers: bare file paths (pdf, txt, etc.)
 *   - parseMediaMarkers: [DINGTALK_VIDEO], [DINGTALK_AUDIO], [DINGTALK_FILE] markers
 *   - parseMediaMarkers: deduplication (same path not added twice)
 *   - parseMediaMarkers: file:// protocol path cleaning
 *   - stripMediaMarkers: removes marker strings and cleans up blank lines
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseMediaMarkers, stripMediaMarkers } = require('../dist-electron/main/im/dingtalkMediaParser.js');

// ---------------------------------------------------------------------------
// Markdown image syntax
// ---------------------------------------------------------------------------

test('markdown image: basic Unix path is detected as image', () => {
  const markers = parseMediaMarkers('Here is a screenshot: ![screenshot](/tmp/screen.png)');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'image');
  assert.equal(markers[0].path, '/tmp/screen.png');
  assert.equal(markers[0].name, 'screenshot');
});

test('markdown image: file:// protocol path is cleaned', () => {
  const markers = parseMediaMarkers('![photo](file:///Users/admin/photo.jpg)');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'image');
  assert.equal(markers[0].path, '/Users/admin/photo.jpg');
});

test('markdown image: tilde home path is detected', () => {
  const markers = parseMediaMarkers('![img](~/Pictures/test.png)');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'image');
});

test('markdown image: no alt text results in empty or undefined name', () => {
  const markers = parseMediaMarkers('![](/tmp/no-alt.png)');
  assert.equal(markers.length, 1);
  assert.ok(markers[0].name === '' || markers[0].name === undefined);
});

test('markdown image: JPEG extension is detected as image', () => {
  const markers = parseMediaMarkers('![photo](/tmp/photo.jpeg)');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'image');
});

// ---------------------------------------------------------------------------
// Markdown link syntax for media files
// ---------------------------------------------------------------------------

test('markdown link: audio file is detected as audio', () => {
  const markers = parseMediaMarkers('Listen to this: [recording](/tmp/audio.mp3)');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'audio');
  assert.equal(markers[0].path, '/tmp/audio.mp3');
  assert.equal(markers[0].name, 'recording');
});

test('markdown link: video file is detected as video', () => {
  const markers = parseMediaMarkers('[demo video](/tmp/demo.mp4)');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'video');
});

test('markdown link: PDF file is detected as file type', () => {
  const markers = parseMediaMarkers('[report](/tmp/report.pdf)');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'file');
});

test('markdown link: HTTP URL is not matched (only local paths)', () => {
  const markers = parseMediaMarkers('[web image](https://example.com/photo.png)');
  assert.equal(markers.length, 0);
});

// ---------------------------------------------------------------------------
// Bare image paths
// ---------------------------------------------------------------------------

test('bare path: image on its own line', () => {
  const markers = parseMediaMarkers('\n/tmp/output.png\n');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'image');
  assert.equal(markers[0].path, '/tmp/output.png');
});

test('bare path: GIF extension detected as image', () => {
  const markers = parseMediaMarkers(' /tmp/animation.gif ');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'image');
});

test('bare path: WebP extension detected as image', () => {
  const markers = parseMediaMarkers('/tmp/image.webp');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'image');
});

// ---------------------------------------------------------------------------
// Bare audio/video paths
// ---------------------------------------------------------------------------

test('bare path: WAV audio file detected as audio', () => {
  const markers = parseMediaMarkers(' /tmp/sound.wav ');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'audio');
});

test('bare path: M4A audio file detected as audio', () => {
  const markers = parseMediaMarkers('/tmp/voice.m4a');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'audio');
});

test('bare path: MOV video file detected as video', () => {
  const markers = parseMediaMarkers(' /tmp/clip.mov ');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'video');
});

// ---------------------------------------------------------------------------
// Bare document/file paths
// ---------------------------------------------------------------------------

test('bare path: txt file detected as file', () => {
  const markers = parseMediaMarkers(' /tmp/notes.txt ');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'file');
});

test('bare path: Excel file detected as file', () => {
  const markers = parseMediaMarkers('/tmp/data.xlsx');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'file');
});

test('bare path: ZIP archive detected as file', () => {
  const markers = parseMediaMarkers(' /tmp/archive.zip ');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'file');
});

// ---------------------------------------------------------------------------
// DingTalk explicit markers
// ---------------------------------------------------------------------------

test('DINGTALK_VIDEO marker: parsed as video', () => {
  const text = '[DINGTALK_VIDEO]{"path":"/tmp/video.mp4","title":"My Video"}[/DINGTALK_VIDEO]';
  const markers = parseMediaMarkers(text);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'video');
  assert.equal(markers[0].path, '/tmp/video.mp4');
  assert.equal(markers[0].name, 'My Video');
  assert.equal(markers[0].originalMarker, text);
});

test('DINGTALK_AUDIO marker: parsed as audio', () => {
  const text = '[DINGTALK_AUDIO]{"path":"/tmp/audio.mp3"}[/DINGTALK_AUDIO]';
  const markers = parseMediaMarkers(text);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'audio');
  assert.equal(markers[0].path, '/tmp/audio.mp3');
});

test('DINGTALK_FILE marker: parsed as file with name', () => {
  const text = '[DINGTALK_FILE]{"path":"/tmp/doc.pdf","name":"Report 2025"}[/DINGTALK_FILE]';
  const markers = parseMediaMarkers(text);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'file');
  assert.equal(markers[0].path, '/tmp/doc.pdf');
  assert.equal(markers[0].name, 'Report 2025');
});

test('DINGTALK_FILE marker: fallback to fileName field', () => {
  const text = '[DINGTALK_FILE]{"path":"/tmp/sheet.xlsx","fileName":"Data Sheet"}[/DINGTALK_FILE]';
  const markers = parseMediaMarkers(text);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].name, 'Data Sheet');
});

test('DINGTALK_VIDEO marker: malformed JSON is skipped gracefully', () => {
  const text = '[DINGTALK_VIDEO]{BROKEN JSON}[/DINGTALK_VIDEO]';
  const markers = parseMediaMarkers(text);
  assert.equal(markers.length, 0);
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

test('dedup: same path from markdown image and bare path is added once', () => {
  const text = '![screenshot](/tmp/screen.png)\n/tmp/screen.png';
  const markers = parseMediaMarkers(text);
  assert.equal(markers.length, 1);
});

test('dedup: two markdown images with different paths are both added', () => {
  const text = '![a](/tmp/a.png) ![b](/tmp/b.png)';
  const markers = parseMediaMarkers(text);
  assert.equal(markers.length, 2);
});

test('dedup: DINGTALK_FILE and bare path pointing to same file only adds once', () => {
  const text =
    '[DINGTALK_FILE]{"path":"/tmp/doc.pdf"}[/DINGTALK_FILE]\n /tmp/doc.pdf ';
  const markers = parseMediaMarkers(text);
  assert.equal(markers.length, 1);
});

// ---------------------------------------------------------------------------
// Escaped spaces in paths
// ---------------------------------------------------------------------------

test('path: escaped space in file:// path is decoded', () => {
  const markers = parseMediaMarkers('![img](file:///Users/admin/my%20photo.jpg)');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].path, '/Users/admin/my photo.jpg');
});

// ---------------------------------------------------------------------------
// Empty / no matches
// ---------------------------------------------------------------------------

test('empty text returns empty array', () => {
  assert.deepEqual(parseMediaMarkers(''), []);
});

test('plain text without paths returns empty array', () => {
  assert.deepEqual(parseMediaMarkers('Hello, how are you?'), []);
});

test('HTTP URL image is not matched', () => {
  assert.equal(parseMediaMarkers('![img](https://cdn.example.com/photo.png)').length, 0);
});

// ---------------------------------------------------------------------------
// stripMediaMarkers
// ---------------------------------------------------------------------------

test('stripMediaMarkers: removes markdown image from text', () => {
  const text = 'Here is my image: ![shot](/tmp/screen.png)\nSome other text.';
  const markers = parseMediaMarkers(text);
  const stripped = stripMediaMarkers(text, markers);
  assert.ok(!stripped.includes('![shot]'));
  assert.ok(stripped.includes('Some other text.'));
});

test('stripMediaMarkers: removes DingTalk video marker', () => {
  const marker = '[DINGTALK_VIDEO]{"path":"/tmp/v.mp4"}[/DINGTALK_VIDEO]';
  const text = `Check this out:\n${marker}\nEnd.`;
  const markers = parseMediaMarkers(text);
  const stripped = stripMediaMarkers(text, markers);
  assert.ok(!stripped.includes('[DINGTALK_VIDEO]'));
  assert.ok(stripped.includes('Check this out:'));
  assert.ok(stripped.includes('End.'));
});

test('stripMediaMarkers: cleans up excessive blank lines after removal', () => {
  const text = 'Line 1\n\n\n\n!/tmp/screen.png\n\n\n\nLine 2';
  const markers = parseMediaMarkers('!/tmp/screen.png');
  const stripped = stripMediaMarkers(text, markers);
  // Should have at most 2 consecutive newlines
  assert.ok(!/\n{3,}/.test(stripped));
});

test('stripMediaMarkers: no markers means text is returned trimmed', () => {
  const text = '  Hello world  ';
  const stripped = stripMediaMarkers(text, []);
  assert.equal(stripped, 'Hello world');
});
