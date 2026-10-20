// Merge real files with the virtual folders implied by configured download paths.
export function directoryEntries(path, localEntries, routePaths) {
  const prefix = path === '/' ? '/' : `${path.replace(/\/$/, '')}/`;
  const entries = new Map((localEntries ?? []).map(entry => [entry.name, entry]));
  let exists = localEntries !== null || prefix === '/';
  for (const route of routePaths) {
    if (!route.startsWith(prefix)) continue;
    exists = true;
    const remaining = route.slice(prefix.length);
    const slash = remaining.indexOf('/');
    const name = slash < 0 ? remaining : remaining.slice(0, slash);
    if (slash < 0) entries.set(name, { name, type: 'file', size: null, modified: null });
    else if (!entries.has(name)) entries.set(name, { name, type: 'directory' });
  }
  if (!exists) return null;
  return [...entries.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

export function manifestDirectories(manifest) {
  const directories = new Map([['/', []]]);
  for (const entry of manifest) {
    if (entry.type === 'directory') directories.set(entry.path, []);
  }
  for (const { path, ...metadata } of manifest) {
    const plain = path.replace(/\/$/, '');
    const slash = plain.lastIndexOf('/');
    const parent = plain.slice(0, slash + 1);
    directories.get(parent)?.push({ ...metadata, name: plain.slice(slash + 1) });
  }
  return path => directories.get(path === '/' ? '/' : `${path.replace(/\/$/, '')}/`) ?? null;
}

export const encodePath = path => path.split('/').map(encodeURIComponent).join('/');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function fileSize(size) {
  if (size === null || size === undefined) return '-';
  if (size < 1024) return `${size} B`;
  const unit = Math.min(Math.floor(Math.log(size) / Math.log(1024)), 4);
  return `${(size / 1024 ** unit).toFixed(1)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
}

export function directoryHtml(path, entries) {
  const title = `Index of ${escapeHtml(path)}`;
  const parent = path === '/' ? '' : '<tr><td><a href="../">../</a></td><td>-</td><td>-</td></tr>';
  const rows = entries.map(entry => {
    const name = entry.name + (entry.type === 'directory' ? '/' : '');
    const href = encodePath(path + name);
    const modified = entry.modified ? new Date(entry.modified).toISOString().slice(0, 19).replace('T', ' ') : '-';
    return `<tr><td><a href="${escapeHtml(href)}">${escapeHtml(name)}</a></td><td>${modified}</td><td>${fileSize(entry.size)}</td></tr>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body{margin:24px;color:#222;background:#fff;font:14px/1.6 monospace}
h1{font-size:20px;font-weight:normal;overflow-wrap:anywhere}
a{color:#00e}a:visited{color:#551a8b}
.listing{overflow-x:auto}table{border-collapse:collapse;min-width:560px}
th,td{padding:3px 28px 3px 0;text-align:left;white-space:nowrap}
th{font-weight:normal;border-bottom:1px solid #aaa;padding-bottom:8px}
td:first-child{min-width:260px}td:last-child,th:last-child{text-align:right;padding-right:0}
tbody tr:first-child td{padding-top:8px}hr{border:0;border-top:1px solid #aaa;margin-top:20px}
@media(max-width:600px){body{margin:16px}}
</style>
</head>
<body>
<h1>${title}</h1>
<div class="listing"><table>
<thead><tr><th>Name</th><th>Last modified (UTC)</th><th>Size</th></tr></thead>
<tbody>${parent}${rows}</tbody>
</table></div>
<hr>
</body>
</html>`;
}
