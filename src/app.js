import { Hono } from 'hono';
import { directoryHtml, encodePath } from './directory.js';

export const HEALTH_PATH = '/_iapp-dl/health';

// Paths in routes.json are decoded URL paths, including Unicode filenames.
export function validPath(path) {
  return typeof path === 'string' && path.startsWith('/') &&
    !/[\\\u0000-\u001f\u007f:#?]/u.test(path) &&
    path.slice(1).split('/').every(part => part && !part.startsWith('.'));
}

export function compileRoutes(config) {
  if (!config || config.schema !== 1 || !config.routes ||
      typeof config.routes !== 'object' || Array.isArray(config.routes) ||
      Object.keys(config).some(key => !['schema', 'routes'].includes(key))) {
    throw new Error('Expected { "schema": 1, "routes": { "/path": "https://..." } }');
  }
  const result = new Map();
  for (const [path, target] of Object.entries(config.routes)) {
    if (!validPath(path) || path === HEALTH_PATH) {
      throw new Error(`Invalid or reserved resource path: ${path}`);
    }
    let url;
    try {
      if (typeof target !== 'string' || /[\s\u0000-\u001f\u007f]/u.test(target)) {
        throw new Error();
      }
      url = new URL(target);
      if (url.protocol !== 'https:' || !url.hostname || url.username ||
          url.password || url.hash) throw new Error();
    } catch {
      // Do not print target URLs: their queries can contain credentials.
      throw new Error(`Expected an HTTPS download URL without credentials or fragment: ${path}`);
    }
    result.set(path, url.href);
  }
  return result;
}

export function createApp({ lookup, staticFiles, listDirectory, onError = console.error }) {
  const app = new Hono();
  app.onError((error, c) => {
    onError(error);
    c.header('Cache-Control', 'no-store');
    return c.text('Service unavailable\n', 503);
  });
  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      c.header('Allow', 'GET, HEAD');
      c.header('Cache-Control', 'no-store');
      return c.text('Method not allowed\n', 405);
    }
    let path;
    try {
      path = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      c.header('Cache-Control', 'no-store');
      return c.text('Invalid path\n', 400);
    }
    if (path !== '/' && !validPath(path.endsWith('/') ? path.slice(0, -1) : path)) return c.notFound();
    if (path === HEALTH_PATH) {
      c.header('Cache-Control', 'no-store');
      return c.text('ok\n');
    }
    const target = await lookup(path);
    if (target !== undefined) {
      c.header('Cache-Control', 'no-store');
      // Only configured destinations are used; request queries are not forwarded.
      c.header('Location', target);
      return c.body(null, 302);
    }
    c.set('resourcePath', path);
    // Local files can later become redirects, so never pin them in browser caches.
    c.header('Cache-Control', 'no-store');
    await next();
  });
  if (staticFiles) app.use('*', (c, next) =>
    c.get('resourcePath').endsWith('/') ? next() : staticFiles(c, next));
  if (listDirectory) app.use('*', async (c, next) => {
    const path = c.get('resourcePath');
    const entries = await listDirectory(path);
    if (entries === null) return next();
    if (!path.endsWith('/')) return c.redirect(encodePath(path) + '/', 302);
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    return c.html(directoryHtml(path, entries));
  });
  app.notFound(c => {
    c.header('Cache-Control', 'no-store');
    return c.text('Not found\n', 404);
  });
  return app;
}
