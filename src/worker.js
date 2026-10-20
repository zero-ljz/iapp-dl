import { compileRoutes, createApp } from './app.js';
import { directoryEntries, manifestDirectories } from './directory.js';

export function createWorker(configuration, { assets = [], ...options } = {}) {
  const routes = compileRoutes(configuration);
  const readDirectory = manifestDirectories(assets);
  const files = new Set(assets.filter(entry => entry.type === 'file').map(entry => entry.path));
  return createApp({
    ...options,
    lookup: path => routes.get(path),
    listDirectory: path => directoryEntries(path, readDirectory(path), routes.keys()),
    staticFiles: async (c, next) => {
      if (!files.has(c.get('resourcePath')) || !c.env.ASSETS) return next();
      const asset = await c.env.ASSETS.fetch(c.req.raw);
      if (asset.status === 404) return next();
      const headers = new Headers(asset.headers);
      headers.set('Cache-Control', 'no-store');
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
    },
  });
}
