import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-host-smoke-'));
// Must be set before importing Pi or the extension. Never touch live settings.
process.env.PI_CODING_AGENT_DIR = path.join(sandbox, 'agent');
process.chdir(sandbox);
try {
  const host = fs.realpathSync(path.join(root, 'node_modules/@earendil-works/pi-coding-agent'));
  const { loadExtensions } = await import(pathToFileURL(path.join(host, 'dist/core/extensions/loader.js')).href);
  const loaded = await loadExtensions([path.join(root,'index.ts')], sandbox);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.ok(extension.tools.has('recall'));
  assert.ok(extension.handlers.has('session_before_compact'));
  assert.ok(extension.handlers.has('context'));
  assert.ok(extension.commands.size >= 4);
  const { version } = JSON.parse(fs.readFileSync(path.join(host, 'package.json'), 'utf8'));
  console.log(`Pi ${version} host loader: extension initialized; recall, commands and compaction hooks registered.`);
} finally {
  process.chdir(root);
  fs.rmSync(sandbox, {recursive: true, force: true});
}
