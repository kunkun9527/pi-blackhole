import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installHostInlineCompactionAdapter } from '../src/om/inline-compaction.js';

const entrypoint = realpathSync(fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url)));
const status = await installHostInlineCompactionAdapter({ entrypoint, stack: '' });
assert.equal(status.supported, true, status.reason);
console.log('Host inline compaction supported:', entrypoint);
