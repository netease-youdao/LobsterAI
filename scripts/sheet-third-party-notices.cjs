'use strict';

// Third-party notices for the Excel editor, built like scripts/word-third-party-notices.cjs.
// --write is for a reviewed dependency update. Normal builds only verify the checked-in
// notices and exact dependency versions; they never silently update them.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'resources/sheet-licenses');
const allowed = new Set(['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', '0BSD']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const packages = new Map();
const noticeSections = [];

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const roots = [...Object.keys(packageJson.dependencies).filter(name => name.startsWith('@univerjs/')).sort(), 'rxjs', 'fflate', 'echarts'];

/** Tarballs without a full license text, completed from the project's own source. */
const UPSTREAM = {
  'react-remove-scroll-bar@2.3.8': {
    file: 'upstream/react-remove-scroll-bar-2.3.8.txt',
    label: 'LICENSE (added by the author upstream in commit 7301c160fda44cb8cf2b9fdfde61efad35736196; 2.3.8 declares MIT)',
  },
  'franc-min@6.2.0': {
    file: 'upstream/franc-min-6.2.0.txt',
    label: 'license (upstream gitHead 3f9f0b51a96c5df32a407dad865a3011ac0fa2d1)',
  },
};
/** Packages whose complete permission text is the License section of their README. */
const README_LICENSE = {
  'ot-json1@1.0.2': /^##\s+License\s*$/m,
  'ot-text-unicode@4.0.0': /^#\s+License\s*$/m,
  'unicount@1.1.0': /^#\s+LICENSE\s*$/m,
};
/** Published from the Univer monorepo without its own copy of the repository license. */
const REPOSITORY_LICENSE = { '@univerjs/protocol@1.0.2': '@univerjs/core' };

function resolveDependency(from, name) {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(directory) === directory) throw new Error(`Missing Excel editor dependency: ${name}`);
  }
}

function readmeLicense(directory, heading) {
  const readme = fs.readdirSync(directory).find(name => /^readme(\.md)?$/i.test(name));
  const text = readme ? fs.readFileSync(path.join(directory, readme), 'utf8') : '';
  const match = heading.exec(text);
  if (!match) return undefined;
  const rest = text.slice(match.index);
  const next = rest.slice(match[0].length).search(/^#{1,2}\s/m);
  return (next < 0 ? rest : rest.slice(0, match[0].length + next)).trim();
}

function collect(directory) {
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const id = `${pkg.name}@${pkg.version}`;
  if (packages.has(id)) return;
  if (pkg.name.startsWith('@univerjs-pro/')) throw new Error(`Commercial Univer package in the Excel editor graph: ${id}`);
  if (!allowed.has(pkg.license)) throw new Error(`Review the Excel editor dependency license before distribution: ${id} (${pkg.license})`);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile() && /^(licen[cs]e|notice|third.party)/i.test(entry.name)).map(entry => entry.name).sort();
  const materials = files.map(name => ({ name, bytes: fs.readFileSync(path.join(directory, name)) }));
  if (UPSTREAM[id]) materials.push({ name: UPSTREAM[id].label, bytes: fs.readFileSync(path.join(output, UPSTREAM[id].file)) });
  if (README_LICENSE[id]) {
    const text = readmeLicense(directory, README_LICENSE[id]);
    if (!text) throw new Error(`README license section not found for ${id}`);
    materials.push({ name: 'README (License section)', bytes: Buffer.from(`${text}\n`) });
  }
  if (REPOSITORY_LICENSE[id]) {
    const source = resolveDependency(directory, REPOSITORY_LICENSE[id]);
    materials.push({ name: `LICENSE (Univer repository, as published in ${REPOSITORY_LICENSE[id]})`, bytes: fs.readFileSync(path.join(source, 'LICENSE')) });
  }
  if (!materials.some(material => /permission is hereby granted|apache license|redistribution and use|permission to use, copy, modify/i.test(material.bytes.toString('utf8')))) {
    throw new Error(`Missing full license text for ${id}`);
  }
  const record = { name: pkg.name, version: pkg.version, license: pkg.license,
    materials: materials.map(material => ({ file: material.name, sha256: hash(material.bytes) })) };
  packages.set(id, record);
  noticeSections.push({ id, text: [`## ${id} — ${pkg.license}`, ...materials.map(material => `### ${material.name}\n\n${material.bytes.toString('utf8').trim()}`)].join('\n\n') });
  for (const dependency of Object.keys(pkg.dependencies || {}).sort()) collect(resolveDependency(directory, dependency));
}

for (const name of roots) collect(resolveDependency(root, name));
const manifest = {
  scope: 'Excel editor only; not a whole-application license audit',
  roots,
  packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)),
};
const preamble = `LobsterAI Excel editing — third-party notices

LobsterAI's own integration code, including its .xlsx reader and writer, is MIT
licensed. Third-party components retain their original licenses below. Only the
Apache-2.0 open-source Univer packages are used; no @univerjs-pro package, no
Univer preset that bundles commercial plugins, and no Univer conversion service
is part of this integration.

Tarballs without a full license text are completed from their own projects:
react-remove-scroll-bar 2.3.8 (MIT) from the LICENSE its author added upstream
(https://github.com/theKashey/react-remove-scroll-bar/blob/7301c160fda44cb8cf2b9fdfde61efad35736196/LICENSE),
franc-min 6.2.0 (MIT) from its npm gitHead
(https://github.com/wooorm/franc/blob/3f9f0b51a96c5df32a407dad865a3011ac0fa2d1/license),
ot-json1, ot-text-unicode and unicount from the License sections of their
published READMEs, and @univerjs/protocol from the Univer repository license.

This inventory covers the Excel editor dependency graph, not unrelated LobsterAI
dependencies. Versions and license materials are verified at build time.
`;
const notices = preamble + '\n' + noticeSections.sort((a, b) => a.id.localeCompare(b.id)).map(section => section.text).join('\n\n') + '\n';
const outputs = { 'NOTICE.txt': notices, 'manifest.json': JSON.stringify(manifest, null, 2) + '\n' };
for (const [name, contents] of Object.entries(outputs)) {
  const target = path.join(output, name);
  if (process.argv.includes('--write')) {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(target, contents);
  } else if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== contents) {
    throw new Error(`Excel editor dependencies/notices changed (${name}). Review the installed versions and licenses, then run node scripts/sheet-third-party-notices.cjs --write.`);
  }
}
console.log(`[SheetLicenses] Verified ${packages.size} dependency packages.`);
