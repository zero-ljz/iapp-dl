import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createApp } from './app.js';
import { createFileStore } from './file-store.js';
import { directoryEntries } from './directory.js';
import { listPublicDirectory, publicEntry } from './local-files.js';

const PROJECT = fileURLToPath(new URL('../', import.meta.url));

export async function publicFiles(directory) {
  const root = resolve(directory);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('public/ must be a real directory');
  }
  const sendFile = serveStatic({
    root,
    allowPercentInPath: true,
    rewriteRequestPath: (_path, c) => c.get('resourcePath').slice(1),
  });
  return async (c, next) => {
    const entry = await publicEntry(root, c.get('resourcePath'));
    if (!entry?.isFile()) return next();
    c.header('Accept-Ranges', 'bytes');
    return sendFile(c, next);
  };
}

export async function startServer({
  config = join(PROJECT, 'routes.json'),
  publicDir = join(PROJECT, 'public'),
  hostname = '127.0.0.1', port = 8787, reloadMs = 1000,
  onError = error => console.error(error.message),
  onChange = count => console.log(`Reloaded ${count} redirect(s)`),
} = {}) {
  const store = await createFileStore(config, { onError, onChange });
  const app = createApp({ lookup: store.lookup, staticFiles: await publicFiles(publicDir), onError,
    listDirectory: async path => directoryEntries(path,
      await listPublicDirectory(publicDir, path), store.paths()),
  });
  const server = serve({ fetch: app.fetch, hostname, port });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise((done, reject) => {
    server.once('listening', done);
    server.once('error', reject);
  });
  const timer = setInterval(() => { void store.reload(); }, reloadMs);
  timer.unref();
  return {
    server, store,
    async close() {
      clearInterval(timer);
      await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
    },
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '8787' },
    'reload-ms': { type: 'string', default: '1000' },
  } });
  const port = Number(values.port);
  const reloadMs = Number(values['reload-ms']);
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      !Number.isInteger(reloadMs) || reloadMs < 100) throw new Error('Invalid port or reload interval');
  const instance = await startServer({ hostname: values.host, port, reloadMs });
  console.log(`iapp-dl listening on ${values.host}:${port}; static root: ${join(PROJECT, 'public')}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await instance.close();
    clearTimeout(force);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
