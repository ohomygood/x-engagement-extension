// Bundle the Node license server (server/node-server.mjs + worker/src/index.ts) into server-dist/server.mjs.
import { build } from 'esbuild';
await build({ entryPoints: ['server/node-server.mjs'], bundle: true, platform: 'node', format: 'esm', target: 'node20',
              outfile: 'server-dist/server.mjs', legalComments: 'none' });
console.log('built server-dist/server.mjs');
