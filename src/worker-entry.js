import config from '../routes.json' with { type: 'json' };
import assets from '../build/asset-index.json' with { type: 'json' };
import { createWorker } from './worker.js';

export default createWorker(config, { assets });
