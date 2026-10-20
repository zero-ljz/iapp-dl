import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validPath } from './app.js';

export async function publicEntry(root, path) {
  const plain = path === '/' ? '/' : path.replace(/\/$/, '');
  if (plain !== '/' && !validPath(plain)) return null;
  const parts = plain === '/' ? [] : plain.slice(1).split('/');
  let current = root;
  let entry;
  try {
    entry = await lstat(root);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
    for (const part of parts) {
      if (!entry.isDirectory()) return null;
      current = join(current, part);
      entry = await lstat(current);
      if (entry.isSymbolicLink()) return null;
    }
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
  return entry;
}

export async function listPublicDirectory(root, path) {
  const directory = await publicEntry(root, path);
  if (!directory?.isDirectory()) return null;
  const prefix = path === '/' ? '/' : `${path.replace(/\/$/, '')}/`;
  const entries = [];
  for (const name of await readdir(join(root, prefix))) {
    const entry = await publicEntry(root, prefix + name);
    if (!entry || (!entry.isFile() && !entry.isDirectory())) continue;
    entries.push({ name, type: entry.isDirectory() ? 'directory' : 'file',
      size: entry.isFile() ? entry.size : null, modified: entry.mtime.toISOString() });
  }
  return entries;
}
