import { mkdir, readFile, copyFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const project = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^obsidian-yuhanbo-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.name)) throw new Error('Invalid project name');
if (manifest.id !== 'yuhanbo-editing' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid manifest');
if (manifest.name !== project.name.replace(/^obsidian-/, '')) throw new Error('Plugin display name must match the yuhanbo project name');
const dist = path.join(root, 'dist');
const destination = path.join(dist, manifest.version, manifest.id);
const files = ['main.js', 'manifest.json', 'styles.css', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/feature-matrix.md', 'licenses/opencc-js-MIT.txt', 'licenses/Apache-2.0.txt', 'licenses/opencc-js-THIRD_PARTY_LICENSES.md'];
for (const filename of files) { await mkdir(path.dirname(path.join(destination, filename)), { recursive: true }); await copyFile(path.join(root, filename), path.join(destination, filename)); }
// 阻止旧构建留下的本地文件随整个目录进入 ZIP。
const staged = await readdir(destination, { recursive: true, withFileTypes: true });
const expectedDirectories = new Set(['docs', 'licenses']);
for (const entry of staged) {
  const relative = path.relative(destination, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/');
  if (entry.isDirectory() ? !expectedDirectories.has(relative) : !entry.isFile() || !files.includes(relative)) {
    throw new Error(`Unexpected file in ZIP staging: ${relative}`);
  }
}
const zip = path.join(dist, `${project.name}-${manifest.version}.zip`);
if (process.platform !== 'win32') throw new Error('Run packaging on Windows PowerShell; production build is portable.');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -LiteralPath ${quote(destination)} -DestinationPath ${quote(zip)} -Force`], { stdio: 'inherit', windowsHide: true });
if (result.status !== 0) throw new Error('Archive creation failed');
const hashes = [];
for (const filename of files) {
  const data = await readFile(path.join(destination, filename));
  hashes.push({ path: `${manifest.version}/${manifest.id}/${filename}`, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
}
const zipData = await readFile(zip);
hashes.push({ path: path.basename(zip), bytes: zipData.length, sha256: createHash('sha256').update(zipData).digest('hex') });
await writeFile(path.join(dist, 'SHA256.json'), JSON.stringify(hashes, null, 2) + '\n');
console.log(zip);
