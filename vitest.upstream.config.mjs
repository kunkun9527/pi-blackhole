import { defineConfig } from '../pi-blackhole-upstream/node_modules/vitest/dist/config.js';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  test: { globals: true, environment: 'node', testTimeout: 15000, include: ['upstream-tests/**/*.test.ts', 'src/**/*.test.ts'], maxWorkers: 4 },
  resolve: { alias: [
    { find: /^vitest$/, replacement: fileURLToPath(new URL('../pi-blackhole-upstream/node_modules/vitest/dist/index.js', import.meta.url)) },
    { find: /\.js$/, replacement: '' },
  ] },
});
