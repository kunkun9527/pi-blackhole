// Bind runtime packages to the installed Pi, not another extension's dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.PI_HOST_PACKAGE || path.join(process.env.APPDATA || '', 'npm/node_modules/@earendil-works/pi-coding-agent');
const metadata = JSON.parse(fs.readFileSync(path.join(host, 'package.json'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).peerDependencies['@earendil-works/pi-coding-agent'];
if (metadata.version !== expected) throw new Error(`Expected Pi ${expected}, got ${metadata.version}; revalidate before upgrading.`);
const modules = path.join(root, 'node_modules');
if (fs.existsSync(modules) && fs.lstatSync(modules).isSymbolicLink()) throw new Error('Refusing to write through node_modules junction');
fs.mkdirSync(modules, {recursive: true});
const targets = {
  '@earendil-works/pi-coding-agent': host,
  ...Object.fromEntries(['pi-ai','pi-agent-core','pi-tui'].map(name => [`@earendil-works/${name}`,path.join(host,'node_modules/@earendil-works',name)])),
  'typebox': path.join(host,'node_modules/typebox'),
  '@types/node': path.join(host,'node_modules/@types/node'),
  'undici-types': path.join(host,'node_modules/undici-types'),
};
for (const [name, target] of Object.entries(targets)) {
  if (!fs.existsSync(path.join(target, 'package.json'))) throw new Error(`Missing ${target}`);
  const dest = path.join(modules, name);
  if (fs.existsSync(dest)) {
    if (fs.realpathSync(dest).toLowerCase() !== fs.realpathSync(target).toLowerCase()) throw new Error(`Unexpected existing dependency: ${dest}`);
    continue;
  }
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  fs.symlinkSync(target,dest,process.platform === 'win32' ? 'junction' : 'dir');
  console.log(`Linked ${name}`);
}
console.log(`Runtime dependencies bound to Pi ${metadata.version}`);
