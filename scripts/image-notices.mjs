#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'third_party');
const check = process.argv.includes('--check');
const platform = 'linux/amd64';
const images = [
  { name: 'node', version: '24.22.1-bookworm-slim', digest: 'sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205', upstream: 'https://github.com/nodejs/node/tree/v24.22.1', license: 'MIT AND bundled third-party licenses', source: 'https://nodejs.org/dist/v24.22.1/node-v24.22.1.tar.xz' },
  { name: 'postgres', version: '18.6-alpine', digest: 'sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873', upstream: 'https://github.com/postgres/postgres/tree/REL_18_6', license: 'PostgreSQL', source: 'https://ftp.postgresql.org/pub/source/v18.6/postgresql-18.6.tar.bz2', legal: ['https://raw.githubusercontent.com/postgres/postgres/REL_18_6/COPYRIGHT'] },
  { name: 'caddy', version: '2.11.7-alpine', digest: 'sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f', upstream: 'https://github.com/caddyserver/caddy/tree/v2.11.7', license: 'Apache-2.0 AND bundled third-party licenses', source: 'https://github.com/caddyserver/caddy/archive/refs/tags/v2.11.7.tar.gz', legal: ['https://raw.githubusercontent.com/caddyserver/caddy/v2.11.7/LICENSE', 'https://raw.githubusercontent.com/caddyserver/caddy/v2.11.7/NOTICE'] },
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function artifact(relative, bytes) {
  const target = path.join(output, relative);
  if (check) {
    if (!(await readFile(target)).equals(Buffer.from(bytes))) throw new Error(`Stale image attribution: ${relative}`);
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
const unresolved = [];
const records = [];
for (const image of images) {
  const reference = `${image.name}:${image.version}@${image.digest}`;
  const deployment = await readFile(path.join(root, 'deploy', image.name === 'node' ? 'Dockerfile' : 'docker-compose.yml'), 'utf8');
  if (!deployment.includes(reference)) throw new Error(`Update image attribution sources for the current deployment pin: ${reference}`);
  const run = command => execFileSync('docker', ['run', '--rm', '--platform', platform, '--entrypoint', 'sh', reference, '-c', command], { maxBuffer: 128 * 1024 * 1024 });
  const files = [];
  const index = JSON.parse(execFileSync('docker', ['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Manifest}}']).toString());
  const selected = index.manifests.find(manifest => manifest.platform?.os === 'linux' && manifest.platform?.architecture === 'amd64');
  if (!selected) throw new Error(`No ${platform} variant: ${reference}`);
  image.variantDigest = selected.digest;
  image.containerSource = selected.annotations?.['org.opencontainers.image.source'] || null;
  image.containerSourceRevision = selected.annotations?.['org.opencontainers.image.revision'] || null;
  files.push({ path: 'OCI image index', material: await material(`${JSON.stringify(index, null, 2)}\n`) });
  const osRelease = run('cat /etc/os-release').toString();
  let packages;
  if (image.name === 'node') {
    const status = run('cat /var/lib/dpkg/status');
    packages = status.toString().trim().split('\n\n').map(block => {
      const get = name => block.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1] || null;
      const source = get('Source') || get('Package');
      const match = source.match(/^([^ ]+)(?: \(([^)]+)\))?$/);
      return { name: get('Package'), version: get('Version'), source, sourceUrl: `https://snapshot.debian.org/package/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2] || get('Version'))}/`, architecture: get('Architecture'), upstream: get('Homepage'), license: 'See package copyright material' };
    });
    files.push({ path: '/var/lib/dpkg/status', material: await material(status) });
    const archive = run('find -L /usr/share/doc /usr/share/common-licenses /usr/local -type f \\( -iname "*license*" -o -iname "*copyright*" -o -iname "*notice*" \\) -print0 | tar --null -T - --hard-dereference -chf -');
    const archivePath = path.join(tmpdir(), `next-round-${image.name}-${process.pid}-legal.tar`);
    await writeFile(archivePath, archive);
    const entries = execFileSync('tar', ['-tf', archivePath]).toString().trim().split('\n');
    for (const entry of entries.sort()) {
      const bytes = execFileSync('tar', ['-xOf', archivePath, '--', entry], { maxBuffer: 32 * 1024 * 1024 });
      files.push({ path: `/${entry}`, material: await material(bytes) });
    }
    await unlink(archivePath);
  } else {
    const database = run('cat /lib/apk/db/installed');
    files.push({ path: '/lib/apk/db/installed', material: await material(database) });
    packages = database.toString().trim().split('\n\n').map(block => {
      const get = key => block.match(new RegExp(`^${key}:(.*)$`, 'm'))?.[1] || null;
      const origin = get('o');
      const commit = get('c');
      return { name: get('P'), version: get('V'), architecture: get('A'), license: get('L'), upstream: get('U'), origin, packagingCommit: commit, source: origin && commit ? `https://gitlab.alpinelinux.org/alpine/aports/-/tree/${commit}` : null };
    });
    for (const entry of packages) {
      if (entry.name.startsWith('.')) continue; // apk virtual dependency group, no payload.
      if (!entry.license || !entry.source || !entry.upstream) unresolved.push({ image: reference, package: entry.name, reason: 'Missing OS package license or upstream/source metadata' });
    }
  }
  for (const url of image.legal || []) {
    const response = await fetch(url);
    if (!response.ok) {
      if (url.endsWith('/NOTICE') && response.status === 404) continue;
      throw new Error(`${response.status}: ${url}`);
    }
    files.push({ url, material: await material(Buffer.from(await response.arrayBuffer())) });
  }
  if (image.name === 'caddy') {
    const buildInfo = run('/usr/bin/caddy build-info');
    files.push({ path: 'caddy build-info', material: await material(buildInfo) });
    image.bundledGoModules = buildInfo.toString().split('\n').filter(line => line.startsWith('dep\t')).map(line => {
      const [, name, version, checksum] = line.split('\t');
      const escaped = name.replace(/[A-Z]/g, character => `!${character.toLowerCase()}`);
      return { name, version, checksum, source: `https://proxy.golang.org/${escaped}/@v/${version}.zip`, notices: `https://pkg.go.dev/${name}@${version}?tab=licenses` };
    });
  }
  records.push({ ...image, legal: undefined, reference, inventoryPlatform: platform, osRelease, packages, files });
}
await artifact('image-inventory.json', `${JSON.stringify({ format: 'next-round-image-notices/1', images: records, unresolved }, null, 2)}\n`);
// Run after npm generation so the shipped material directory contains only
// files referenced by one of the two current inventories.
const retained = new Set();
function references(value) {
  if (typeof value === 'string' && /^materials\/[a-f0-9]{64}\.txt$/.test(value)) {
    retained.add(value);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) references(child);
  }
}
references({ images: records });
references(JSON.parse(await readFile(path.join(output, 'npm-inventory.json'), 'utf8')));
for (const filename of await readdir(path.join(output, 'materials'))) {
  if (!/^[a-f0-9]{64}\.txt$/.test(filename) || retained.has(`materials/${filename}`)) continue;
  if (check) throw new Error(`Unreferenced attribution material: ${filename}`);
  await unlink(path.join(output, 'materials', filename));
}
console.log(`${records.length} pinned images; ${records.reduce((count, image) => count + image.packages.length, 0)} OS package records; ${unresolved.length} unresolved image notice items`);
if (unresolved.length) process.exitCode = 1;
