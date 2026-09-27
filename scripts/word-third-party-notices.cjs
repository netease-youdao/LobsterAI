'use strict';

// --write is for a reviewed dependency update. Normal builds only verify the
// checked-in notices and exact dependency versions; they never silently update them.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'resources/word-licenses');
const fontsRoot = path.join(root, 'src/renderer/assets/word-fonts');
const allowed = new Set(['MIT', 'Apache-2.0', '(MIT AND Zlib)']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const packages = new Map();
const noticeSections = [];

function resolveDependency(from, name) {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(directory) === directory) throw new Error(`Missing Word dependency: ${name}`);
  }
}

function collect(directory) {
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const id = `${pkg.name}@${pkg.version}`;
  if (packages.has(id)) return;
  if (!allowed.has(pkg.license)) throw new Error(`Review the Word dependency license before distribution: ${id} (${pkg.license})`);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile() && /^(licen[cs]e|notice|third.party)/i.test(entry.name)).map(entry => entry.name).sort();
  if (fs.existsSync(path.join(directory, 'licenses'))) {
    for (const name of fs.readdirSync(path.join(directory, 'licenses')).sort()) files.push(`licenses/${name}`);
  }
  const materials = files.map(name => ({ name, bytes: fs.readFileSync(path.join(directory, name)) }));
  if (id === '@nodable/entities@3.0.0') {
    materials.push({ name: 'LICENSE (upstream gitHead d2070d76a8ba07e6c7fa142caeb51ffd756e47eb)',
      bytes: fs.readFileSync(path.join(output, 'upstream/nodable-entities-3.0.0.txt')) });
  }
  if (!materials.some(material => /permission is hereby granted|apache license|redistribution and use/i.test(material.bytes.toString('utf8')))) {
    throw new Error(`Missing full license text for ${id}`);
  }
  const record = { name: pkg.name, version: pkg.version, license: pkg.license,
    materials: materials.map(material => ({ file: material.name, sha256: hash(material.bytes) })) };
  packages.set(id, record);
  noticeSections.push({ id, text: [`## ${id} — ${pkg.license}`, ...materials.map(material => `### ${material.name}\n\n${material.bytes.toString('utf8').trim()}`)].join('\n\n') });
  for (const dependency of Object.keys(pkg.dependencies || {}).sort()) collect(resolveDependency(directory, dependency));
}

collect(resolveDependency(root, '@docx-editor.dev/core'));
collect(resolveDependency(root, '@docx-editor.dev/i18n'));
const fontSources = JSON.parse(fs.readFileSync(path.join(fontsRoot, 'sources.json'), 'utf8'));
for (const source of fontSources) {
  if (source.license !== 'OFL-1.1') throw new Error(`Review font license: ${source.file}`);
  const bytes = fs.readFileSync(path.join(fontsRoot, source.file));
  if (hash(bytes) !== source.sha256 || bytes.length !== source.bytes) throw new Error(`Word font asset changed: ${source.file}`);
}
const wasm = fs.readFileSync(path.join(resolveDependency(root, '@docx-editor.dev/core'), 'dist/harfbuzz.wasm'));
const manifest = { scope: 'Word editor only; not a whole-application license audit',
  packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)),
  fonts: fontSources, wasm: { package: '@docx-editor.dev/core', file: 'dist/harfbuzz.wasm', sha256: hash(wasm) } };
const preamble = `LobsterAI Word editing — third-party notices

LobsterAI's own integration code is MIT licensed. Third-party components retain
their original licenses below. No proprietary @docx-editor.dev/pro or editor-api
package is part of this integration. Only the listed OFL fonts are redistributed;
the mixed-license @docx-editor.dev/fonts package is not a runtime dependency.

The @nodable/entities 3.0.0 tarball omits its full license. Its upstream gitHead
license is retained from:
https://raw.githubusercontent.com/nodable/val-parsers/d2070d76a8ba07e6c7fa142caeb51ffd756e47eb/LICENSE

Font provenance and SHA-256 hashes are recorded in manifest.json. The font files
are redistributed without modification. HarfBuzz WASM notices are included in
the core package section, including licenses/HarfBuzz-COPYING.txt.

This inventory covers the Word dependency graph and assets, not unrelated
LobsterAI dependencies. Versions and license materials are verified at build time.
`;
const fontNotices = fontSources.filter(source => source.file.startsWith('OFL-')).map(source =>
  `## ${source.file}\n\n${fs.readFileSync(path.join(fontsRoot, source.file), 'utf8').trim()}`).join('\n\n');
const notices = preamble + '\n' + noticeSections.sort((a, b) => a.id.localeCompare(b.id)).map(section => section.text).join('\n\n') + '\n\n' + fontNotices + '\n';
const outputs = { 'NOTICE.txt': notices, 'manifest.json': JSON.stringify(manifest, null, 2) + '\n' };
for (const [name, contents] of Object.entries(outputs)) {
  const target = path.join(output, name);
  if (process.argv.includes('--write')) {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(target, contents);
  } else if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== contents) {
    throw new Error(`Word dependencies/notices changed (${name}). Review the installed versions and licenses, then run node scripts/word-third-party-notices.cjs --write.`);
  }
}
console.log(`[WordLicenses] Verified ${packages.size} dependency packages, ${fontSources.filter(source => !source.file.startsWith('OFL-')).length} fonts, and HarfBuzz WASM.`);
