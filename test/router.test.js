import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { compileRoutes, HEALTH_PATH } from '../src/app.js';
import { createFileStore } from '../src/file-store.js';
import { startServer } from '../src/node.js';
import { createWorker } from '../src/worker.js';
import { createEdgeOne } from '../src/edgeone.js';

const destination = 'https://downloads.example.com/release/model.zip?download=1';
const config = (routes = {}) => ({ schema: 1, routes });

test('configuration rejects unsafe destinations, hidden paths, and schema typos', () => {
  for (const url of ['http://example.com/a', '/relative', 'javascript:alert(1)',
    'https://user:password@example.com/a', 'https://example.com/a#fragment',
    'https://example.com/a\r\nX-Header: value']) {
    assert.throws(() => compileRoutes(config({ '/a': url })));
  }
  for (const path of ['/../a', '//a', '/a/./b', '/a/.env', '/a\\b', '/a:b',
    '/a?b', '/a#b', '/a/', HEALTH_PATH]) {
    assert.throws(() => compileRoutes(config({ [path]: destination })));
  }
  assert.throws(() => compileRoutes({ schema: 1, routes: {}, route: {} }));
  assert.throws(() => compileRoutes({ schema: 1, routes: [] }));
  assert.equal(compileRoutes(config({ '/公式/model-v1.zip': destination })).get('/公式/model-v1.zip'), destination);
});

test('Node serves only public files and redirects take priority', async t => {
  const root = await mkdtemp(join(tmpdir(), 'download-router-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publicDir = join(root, 'public');
  await mkdir(join(publicDir, 'snapneo'), { recursive: true });
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'node.js'), 'private source');
  await writeFile(join(root, 'package.json'), 'private package');
  await writeFile(join(root, 'routes.json'), JSON.stringify(config({ '/model.zip': destination,
    '/external/models/模型 <script>.zip': destination })));
  await writeFile(join(publicDir, 'model.zip'), 'shadowed local file');
  await writeFile(join(publicDir, 'snapneo', 'windows-x64.json'), '{"version":"1.0.2"}');
  await writeFile(join(publicDir, 'local.bin'), '0123456789');
  await writeFile(join(publicDir, '公式 模型.bin'), 'unicode file');
  await writeFile(join(publicDir, '.env'), 'hidden secret');
  await writeFile(join(publicDir, 'snapneo', '.secret'), 'hidden secret');
  await mkdir(join(publicDir, 'empty'));
  await writeFile(join(publicDir, 'index.html'), 'explicit HTML file');
  const errors = [];
  const instance = await startServer({ config: join(root, 'routes.json'), publicDir, port: 0,
    reloadMs: 20, onError: error => errors.push(error), onChange: () => {} });
  t.after(() => instance.close());
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  const request = (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init });

  for (const method of ['GET', 'HEAD']) {
    const response = await request('/model.zip?url=https://evil.example/', { method,
      headers: { Range: 'bytes=5-' } });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), destination);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), '');
  }
  const json = await request('/snapneo/windows-x64.json');
  assert.equal(json.status, 200);
  assert.equal(json.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await json.json(), { version: '1.0.2' });
  const full = await request('/local.bin');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(await full.text(), '0123456789');
  const partial = await request('/local.bin', { headers: { Range: 'bytes=3-' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 3-9/10');
  assert.equal(await partial.text(), '3456789');
  const unsatisfied = await request('/local.bin', { headers: { Range: 'bytes=10-' } });
  assert.equal(unsatisfied.status, 416);
  assert.equal(unsatisfied.headers.get('content-range'), 'bytes */10');
  await unsatisfied.arrayBuffer();
  const head = await request('/local.bin', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
  assert.equal(await (await request('/' + encodeURIComponent('公式 模型.bin'))).text(), 'unicode file');

  for (const path of ['/routes.json', '/package.json', '/src/node.js', '/.env',
    '/%2eenv', '/snapneo/.secret', '/missing/', '/%2e%2e%2fsrc/node.js']) {
    const response = await request(path);
    assert.equal(response.status, 404, path);
    assert.equal(await response.text(), 'Not found\n');
  }
  assert.equal((await request('/%ZZ')).status, 400);
  const post = await request('/model.zip', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  await post.arrayBuffer();
  assert.equal(await (await request(HEALTH_PATH)).text(), 'ok\n');

  const index = await request('/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.equal(index.headers.get('cache-control'), 'no-store');
  const html = await index.text();
  for (const name of ['empty/', 'external/', 'snapneo/', 'index.html', 'model.zip']) {
    assert.ok(html.includes(`href="/${name}"`), name);
  }
  assert.ok(html.indexOf('href="/snapneo/"') < html.indexOf('href="/model.zip"'));
  assert.doesNotMatch(html, /routes\.json|package\.json|\.env|private source|\.secret/);
  assert.match(html, /10 B/);
  const canonical = await request('/snapneo');
  assert.equal(canonical.status, 302);
  assert.equal(canonical.headers.get('location'), '/snapneo/');
  const folder = await (await request('/snapneo/')).text();
  assert.match(folder, /href="\.\.\/"/);
  assert.match(folder, /href="\/snapneo\/windows-x64\.json"/);
  const remoteFolder = await (await request('/external/models/')).text();
  assert.match(remoteFolder, /模型 &lt;script&gt;\.zip/);
  assert.doesNotMatch(remoteFolder, /<script>|https:\/\/downloads/);
  assert.ok(remoteFolder.includes(encodeURIComponent('模型 <script>.zip')));
  assert.equal((await request('/external/models/' + encodeURIComponent('模型 <script>.zip'))).status, 302);
  assert.equal((await request('/empty/')).status, 200);
  const indexHead = await request('/', { method: 'HEAD' });
  assert.equal(indexHead.status, 200);
  assert.equal(await indexHead.text(), '');
  assert.equal(await (await request('/index.html')).text(), 'explicit HTML file');

  // Windows junctions do not require the file symlink privilege.
  await symlink(join(root, 'src'), join(publicDir, 'source-link'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const escaped = await request('/source-link/node.js');
  assert.equal(escaped.status, 404);
  await escaped.arrayBuffer();
  assert.equal((await request('/source-link/')).status, 404);
  assert.doesNotMatch(await (await request('/')).text(), /source-link/);

  // The timer must pick up an atomic replacement, including converting a local
  // file into a redirect without restarting the process.
  const replacement = join(root, 'routes.next.json');
  await writeFile(replacement, JSON.stringify(config({ '/local.bin': destination })));
  await rename(replacement, join(root, 'routes.json'));
  for (let attempt = 0; attempt < 100 && !instance.store.lookup('/local.bin'); attempt++) await delay(20);
  const changed = await request('/local.bin');
  assert.equal(changed.status, 302);
  assert.equal(changed.headers.get('location'), destination);
  const restored = await request('/model.zip');
  assert.equal(restored.status, 200);
  assert.equal(await restored.text(), 'shadowed local file');
  assert.doesNotMatch(await (await request('/')).text(), /href="\/external\/"/);
  assert.equal((await request('/external/')).status, 404);
  assert.deepEqual(errors, []);
});

test('invalid or missing configuration keeps the last working map', async t => {
  const root = await mkdtemp(join(tmpdir(), 'download-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = join(root, 'routes.json');
  await writeFile(filename, JSON.stringify(config({ '/model.zip': destination })));
  const errors = [];
  const store = await createFileStore(filename, { onError: error => errors.push(error.message) });
  await writeFile(filename, '{partial upload');
  assert.equal(await store.reload(), false);
  assert.equal(await store.reload(), false);
  assert.equal(errors.length, 1);
  assert.equal(store.lookup('/model.zip'), destination);
  await rm(filename);
  assert.equal(await store.reload(), false);
  assert.equal(store.lookup('/model.zip'), destination);
  await writeFile(filename, JSON.stringify(config()));
  assert.equal(await store.reload(), true);
  assert.equal(store.lookup('/model.zip'), undefined);
  await writeFile(filename, 'broken');
  await assert.rejects(() => createFileStore(filename));
});

test('Worker uses the same routes and passes local file requests to ASSETS', async () => {
  const calls = [];
  const worker = createWorker(config({ '/model.zip': destination, '/models/v1/model.zip': destination }), {
    assets: [{ path: '/local.bin', type: 'file', size: 10 },
      { path: '/empty/', type: 'directory' }],
  });
  const env = { ASSETS: { fetch: async request => {
    calls.push(request);
    if (new URL(request.url).pathname === '/local.bin') {
      if (request.headers.has('Range')) return new Response('3456789', {
        status: 206, headers: { 'Content-Range': 'bytes 3-9/10', 'Cache-Control': 'public, max-age=9999' },
      });
      return new Response('0123456789');
    }
    return new Response('missing asset', { status: 404 });
  } } };
  const redirect = await worker.fetch(new Request('https://update.example.com/model.zip'), env);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), destination);
  assert.equal(calls.length, 0);
  const partial = await worker.fetch(new Request('https://update.example.com/local.bin', {
    headers: { Range: 'bytes=3-' },
  }), env);
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('cache-control'), 'no-store');
  assert.equal(partial.headers.get('content-range'), 'bytes 3-9/10');
  assert.equal(await partial.text(), '3456789');
  assert.equal(calls[0].headers.get('range'), 'bytes=3-');
  assert.equal((await worker.fetch(new Request('https://update.example.com/.env'), env)).status, 404);
  assert.equal(calls.length, 1);
  assert.equal((await worker.fetch(new Request('https://update.example.com/missing'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://update.example.com/missing'), {})).status, 404);
  const index = await worker.fetch(new Request('https://update.example.com/'), env);
  assert.equal(index.status, 200);
  const html = await index.text();
  assert.match(html, /href="\/models\/"/);
  assert.match(html, /href="\/empty\/"/);
  assert.match(html, /href="\/local\.bin"/);
  assert.match(html, /10 B/);
  assert.equal(calls.length, 1);
  const folder = await worker.fetch(new Request('https://update.example.com/models/v1/'), env);
  assert.match(await folder.text(), /href="\/models\/v1\/model\.zip"/);
  const canonical = await worker.fetch(new Request('https://update.example.com/models'), env);
  assert.equal(canonical.headers.get('location'), '/models/');
  const full = await worker.fetch(new Request('https://update.example.com/local.bin', {
    headers: { Range: 'bytes=3-' },
  }), { ASSETS: { fetch: async () => new Response('0123456789') } });
  assert.equal(full.status, 200);
  assert.equal(await full.text(), '0123456789');
});

test('EdgeOne adapter uses the same routes and forwards published files', async () => {
  const calls = [];
  const app = createEdgeOne(config({ '/model.zip': destination }), {
    assets: [{ path: '/local.bin', type: 'file', size: 10 },
      { path: '/empty/', type: 'directory' }],
    fetchStatic: async request => {
      calls.push(request);
      if (request.url.endsWith('/local.bin')) {
        return new Response('3456789', {
          status: 206,
          headers: { 'Content-Range': 'bytes 3-9/10' },
        });
      }
      return new Response('missing asset', { status: 404 });
    },
  });
  const env = {};
  const redirect = await app.fetch(new Request('https://edge.example/model.zip'), env);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), destination);
  assert.equal(calls.length, 0);

  const partial = await app.fetch(new Request('https://edge.example/local.bin', {
    headers: { Range: 'bytes=3-' },
  }), env);
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('cache-control'), 'no-store');
  assert.equal(partial.headers.get('content-range'), 'bytes 3-9/10');
  assert.equal(calls[0].headers.get('range'), 'bytes=3-');

  const index = await app.fetch(new Request('https://edge.example/'), env);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /href="\/empty\/"/);
  assert.match(await (await app.fetch(new Request('https://edge.example/models/'), env)).text(), /Not found/);
});
