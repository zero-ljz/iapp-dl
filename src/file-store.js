import { readFile, stat } from 'node:fs/promises';
import { compileRoutes } from './app.js';

const MAX_CONFIG_BYTES = 1024 * 1024;

export async function readConfig(filename) {
  if ((await stat(filename)).size > MAX_CONFIG_BYTES) {
    throw new Error('routes.json exceeds 1 MiB');
  }
  const text = await readFile(filename, 'utf8');
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new Error('routes.json exceeds 1 MiB');
  return text;
}

export async function createFileStore(filename, { onError = console.error, onChange = () => {} } = {}) {
  let text = await readConfig(filename);
  let routes = compileRoutes(JSON.parse(text));
  let lastError;
  let inFlight;
  return {
    lookup: path => routes.get(path),
    paths: () => routes.keys(),
    get size() { return routes.size; },
    reload() {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          const next = await readConfig(filename);
          if (next === text) {
            lastError = undefined;
            return false;
          }
          const parsed = compileRoutes(JSON.parse(next));
          routes = parsed;
          text = next;
          lastError = undefined;
          onChange(routes.size);
          return true;
        } catch (error) {
          // A partial upload or invalid edit must not disable the active routes.
          if (lastError !== error.message) onError(error);
          lastError = error.message;
          return false;
        }
      })().finally(() => { inFlight = undefined; });
      return inFlight;
    },
  };
}
