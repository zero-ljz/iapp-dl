import { compileRoutes, createApp } from './app.js';
import { directoryEntries, manifestDirectories } from './directory.js';

// EdgeOne Pages exposes standard Request/Response objects and a fetch() that
// can retrieve a published file from the same Pages project. The manifest is
// generated during the build because Functions cannot read the repository at
// request time.
export function createEdgeOne(configuration, { assets = [], fetchStatic = request => fetch(request), ...options } = {}) {
  const routes = compileRoutes(configuration);
  const readDirectory = manifestDirectories(assets);
  const files = new Set(assets.filter(entry => entry.type === 'file').map(entry => entry.path));
  return createApp({
    ...options,
    lookup: path => routes.get(path),
    listDirectory: path => directoryEntries(path, readDirectory(path), routes.keys()),
    staticFiles: async (c, next) => {
      const path = c.get('resourcePath');
      if (!files.has(path)) return next();

      // Rebuild the request so the Range and HEAD headers reach the platform
      // static-file handler without forwarding a request body.
      const request = new Request(c.req.raw.url, {
        method: c.req.method,
        headers: c.req.raw.headers,
      });
      const asset = await fetchStatic(request);
      if (asset.status === 404) return next();

      const headers = new Headers(asset.headers);
      headers.set('Cache-Control', 'no-store');
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(asset.body, {
        status: asset.status,
        statusText: asset.statusText,
        headers,
      });
    },
  });
}
