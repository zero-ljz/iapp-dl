import configuration from './_generated-config.js';
import assets from './_generated-assets.js';
import { createEdgeOne } from '../src/edgeone.js';

const app = createEdgeOne(configuration, { assets });

export function onRequest(context) {
  return app.fetch(context.request, context.env);
}
