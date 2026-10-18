#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'third_party');
const check = process.argv.includes('--check');
const cache = process.env.NOTICES_CACHE || path.join(tmpdir(), 'next-round-notices-cache');
const require = createRequire(import.meta.url);
const yamlDirectory = (await readdir(path.join(root, 'node_modules/.pnpm'))).filter(name => /^yaml@/.test(name)).sort();
if (yamlDirectory.length !== 1) throw new Error('Run pnpm install --frozen-lockfile; expected one locked yaml parser');
const yaml = require(path.join(root, 'node_modules/.pnpm', yamlDirectory[0], 'node_modules/yaml'));
const lockBytes = await readFile(path.join(root, 'pnpm-lock.yaml'));
const documents = yaml.parseAllDocuments(lockBytes.toString()).map(document => {
  if (document.errors.length) throw document.errors[0];
  return document.toJSON();
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const generated = new Set();
async function artifact(relative, bytes) {
  const target = path.join(destination, relative);
  generated.add(relative);
  if (check) {
    if (!(await readFile(target)).equals(Buffer.from(bytes))) throw new Error(`Stale attribution: ${relative}`);
  } else {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}
async function material(bytes) {
  const relative = `materials/${hash(bytes)}.txt`;
  await artifact(relative, bytes);
  return relative;
}
await mkdir(cache, { recursive: true });
const packages = new Map();
for (const document of documents) {
  for (const [key, value] of Object.entries(document.packages || {})) {
    if (packages.has(key) && JSON.stringify(packages.get(key)) !== JSON.stringify(value)) throw new Error(`Conflicting lock entry: ${key}`);
    packages.set(key, value);
  }
}
const unresolved = [];
const records = [];
const legalFile = /(?:^|\/)(?:licen[cs]e[^/]*|copying[^/]*|notice[^/]*|third[-_ ]?party[^/]*(?:notice|licen[cs]e)[^/]*|copyright[^/]*|authors[^/]*|ofl(?:\.[^/]*)?|unlicense(?:\.[^/]*)?|readme(?:\.[^/]*)?)$|(?:^|\/)(?:licen[cs]es|notices|copyrights)\/.+/i;
const sorted = [...packages].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
let next = 0;
async function collect() {
  while (next < sorted.length) {
    const [key, locked] = sorted[next++];
    const split = key.lastIndexOf('@');
    const name = key.slice(0, split);
    const version = key.slice(split + 1);
    const tarball = locked.resolution?.tarball || `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;
    const archive = path.join(cache, `${hash(key)}.tgz`);
    try {
      let bytes;
      try { bytes = await readFile(archive); } catch {
        const response = await fetch(tarball);
        if (!response.ok) throw new Error(`${response.status}: ${tarball}`);
        bytes = Buffer.from(await response.arrayBuffer());
        await writeFile(archive, bytes);
      }
      const integrity = locked.resolution?.integrity;
      if (!integrity) throw new Error('Missing locked integrity');
      const valid = integrity.split(/\s+/).some(item => {
        const separator = item.indexOf('-');
        return createHash(item.slice(0, separator)).update(bytes).digest('base64') === item.slice(separator + 1);
      });
      if (!valid) throw new Error('Archive does not match locked integrity');
      const entries = execFileSync('tar', ['-tzf', archive], { maxBuffer: 32 * 1024 * 1024 }).toString().split('\n').filter(Boolean);
      if (entries.some(entry => entry.startsWith('/') || entry.split('/').includes('..'))) throw new Error('Unsafe archive paths');
      const manifestPath = entries.find(entry => /^[^/]+\/package\.json$/.test(entry));
      if (!manifestPath) throw new Error('No package manifest');
      const manifestBytes = execFileSync('tar', ['-xOzf', archive, '--', manifestPath], { maxBuffer: 16 * 1024 * 1024 });
      const manifest = JSON.parse(manifestBytes);
      if (manifest.name !== name || manifest.version !== version) throw new Error(`Unexpected manifest ${manifest.name}@${manifest.version}`);
      let license = manifest.license || manifest.licenses;
      if (Array.isArray(license)) license = license.map(value => typeof value === 'string' ? value : value.type).join(' OR ');
      if (license && typeof license !== 'string') license = license.type;
      const files = [];
      let hasLicenseText = false;
      const grant = /Permission is hereby granted|Redistribution and use in source and binary forms|SIL OPEN FONT LICENSE|Apache License[\s\S]*Version 2\.0/i;
      for (const entry of entries.filter(entry => legalFile.test(entry) && !entry.endsWith('/')).sort()) {
        const content = execFileSync('tar', ['-xOzf', archive, '--', entry], { maxBuffer: 32 * 1024 * 1024 });
        files.push({ path: entry, material: await material(content) });
        if (/(?:license|licence|copying|ofl|unlicense)/i.test(path.basename(entry)) || grant.test(content.toString())) hasLicenseText = true;
      }
      if (!hasLicenseText && !name.startsWith('@esbuild/') && !name.startsWith('@rolldown/')) {
        for (const entry of entries.filter(entry => /\.(?:[cm]?js|tsx?|txt)$/i.test(entry)).sort()) {
          const content = execFileSync('tar', ['-xOzf', archive, '--', entry], { maxBuffer: 32 * 1024 * 1024 });
          for (const comment of content.toString().matchAll(/\/\*[\s\S]*?\*\//g)) {
            if (!grant.test(comment[0]) && !/copyright|SPDX-License-Identifier/i.test(comment[0])) continue;
            files.push({ path: entry, material: await material(comment[0]), embeddedLicense: true, byteOffset: Buffer.byteLength(content.toString().slice(0, comment.index)) });
            if (grant.test(comment[0])) hasLicenseText = true;
          }
        }
      }
      const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
      if (!license) unresolved.push({ package: key, reason: 'No license expression in published manifest' });
      if (!repository && !manifest.homepage) unresolved.push({ package: key, reason: 'No upstream repository or homepage in published manifest' });
      records.push({ name, version, license: license || null, repository: repository || null, homepage: manifest.homepage || null, registry: `https://www.npmjs.com/package/${name}/v/${version}`, tarball, integrity, os: locked.os || [], cpu: locked.cpu || [], libc: locked.libc || [], manifest: await material(manifestBytes), files, hasLicenseText });
    } catch (error) {
      unresolved.push({ package: key, reason: error.message });
      records.push({ name, version, tarball, integrity: locked.resolution?.integrity || null, unresolved: error.message });
    }
  }
}
await Promise.all(Array.from({ length: 8 }, collect));
const standardTextSupplements = new Map([
  ['@drizzle-team/brocli@0.10.2', 'Apache-2.0'],
  ['@epic-web/invariant@1.0.0', 'MIT'],
  ['@humanfs/types@0.15.0', 'Apache-2.0'],
  ['abstract-logging@2.0.1', 'MIT'],
  ['drizzle-orm@0.45.4', 'Apache-2.0'],
  ['keyv@4.5.4', 'MIT'],
  ['natural-compare@1.4.0', 'MIT'],
  ['react-remove-scroll-bar@2.3.8', 'MIT'],
]);
const standardTexts = new Map();
for (const record of records) {
  if (record.unresolved || record.hasLicenseText) { delete record.hasLicenseText; continue; }
  const parentName = record.name.startsWith('@esbuild/') ? 'esbuild' : record.name.startsWith('@rolldown/') ? 'rolldown' : null;
  const parent = records.find(candidate => candidate.name === parentName && candidate.version === record.version);
  if (parent && parent.license === record.license && parent.repository === record.repository && parent.files.some(file => /licen[cs]e/i.test(file.path))) {
    record.licenseFromPackage = `${parent.name}@${parent.version}`;
    record.files.push(...parent.files.filter(file => /licen[cs]e|notice|copyright/i.test(file.path)).map(file => ({ ...file, fromPackage: record.licenseFromPackage })));
  } else if (standardTextSupplements.get(`${record.name}@${record.version}`) === record.license) {
    if (!standardTexts.has(record.license)) {
      const url = `https://raw.githubusercontent.com/spdx/license-list-data/v3.28.0/text/${record.license}.txt`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status}: ${url}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      standardTexts.set(record.license, { url, material: await material(bytes) });
    }
    record.files.push({ ...standardTexts.get(record.license), standardLicenseSupplement: true });
    record.licenseTextNote = 'Published archive declares this exact SPDX license but omits a separate license text. SPDX standard text is supplied; its template copyright fields are not assertions about this package. Original package attribution remains in the retained manifest, README and any embedded source notices.';
  } else {
    unresolved.push({ package: `${record.name}@${record.version}`, reason: 'No license text found in archive or reviewed upstream supplement' });
  }
  delete record.hasLicenseText;
}
records.sort((a, b) => `${a.name}@${a.version}` < `${b.name}@${b.version}` ? -1 : 1);
unresolved.sort((a, b) => `${a.package}:${a.reason}` < `${b.package}:${b.reason}` ? -1 : 1);
const graph = documents.map((document, index) => ({ document: index + 1, importers: document.importers || {}, snapshots: document.snapshots || {} }));
const output = { format: 'next-round-third-party/1', lockfileSha256: hash(lockBytes), packageCount: packages.size, packages: records, graph, unresolved };
await artifact('npm-inventory.json', `${JSON.stringify(output, null, 2)}\n`);
console.log(`${records.length}/${packages.size} locked packages; ${unresolved.length} unresolved items; ${generated.size} material/inventory files`);
if (unresolved.length) {
  console.error(JSON.stringify(unresolved, null, 2));
  process.exitCode = 1;
}
