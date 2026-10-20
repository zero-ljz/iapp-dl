import { lstat, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileRoutes, validPath } from '../src/app.js';
import { readConfig } from '../src/file-store.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const workerBuild = process.argv.includes('--worker');
const routes = compileRoutes(JSON.parse(await readConfig(join(project, 'routes.json'))));
const assets = [];

async function inspect(directory, prefix = '/') {
  const root = await lstat(directory);
  if (root.isSymbolicLink()) throw new Error(`Static directory must not be a symbolic link: ${directory}`);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    const resourcePath = prefix + entry.name;
    if (!validPath(resourcePath)) throw new Error(`Unsupported public filename: ${path}`);
    if (entry.isSymbolicLink()) throw new Error(`Static assets must not contain symbolic links: ${path}`);
    const stat = await lstat(path);
    if (!entry.isDirectory() && !entry.isFile()) throw new Error(`Static asset is not a regular file: ${path}`);
    if (workerBuild && entry.isFile() && stat.size > 25 * 1024 ** 2) {
      throw new Error(`Worker static asset exceeds 25 MiB; use an external URL: ${path}`);
    }
    assets.push({ path: resourcePath + (entry.isDirectory() ? '/' : ''),
      type: entry.isDirectory() ? 'directory' : 'file', size: entry.isFile() ? stat.size : null,
      modified: stat.mtime.toISOString() });
    if (entry.isDirectory()) await inspect(path, resourcePath + '/');
  }
}

await inspect(join(project, 'public'));
if (workerBuild) {
  await mkdir(join(project, 'build'), { recursive: true });
  await writeFile(join(project, 'build', 'asset-index.json'), JSON.stringify(assets));
}
console.log(`Valid configuration: ${routes.size} redirect(s); public/ checked`);
