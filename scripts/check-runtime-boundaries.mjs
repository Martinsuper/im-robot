import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = new URL('../src-tauri/src/', import.meta.url);
const root = await readFile(new URL('lib.rs', source), 'utf8');
const bootstrap = await readFile(new URL('bootstrap.rs', source), 'utf8');

assert(!/^use\s/m.test(root), 'lib.rs must not serve as a dependency facade');
assert(!/^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|const|static|type)\s/m.test(root),
  'Application state and domain types belong in their owning modules');
const functions = [...root.matchAll(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/gm)];
assert.deepEqual(functions.map(match => match[1]), ['run'], 'lib.rs only exposes the entry point');
assert.match(root, /pub fn run\(\)\s*\{\s*bootstrap::run\(\);\s*\}/);

const modules = [...root.matchAll(/^(?:pub\s+)?mod\s+(\w+);/gm)].map(match => match[1]);
for (const name of modules) {
  let contents;
  try {
    contents = await readFile(new URL(`${name}.rs`, source), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    contents = await readFile(new URL(`${name}/mod.rs`, source), 'utf8');
  }
  assert(!/use\s+crate::\*/.test(contents), `${name} must import its dependencies explicitly`);
}

const marker = '.invoke_handler(tauri::generate_handler![';
const start = bootstrap.indexOf(marker);
assert(start >= 0, 'Application bootstrap must register its IPC commands');
const end = bootstrap.indexOf('])', start);
assert(end > start, 'IPC registry must be complete');
const entries = bootstrap.slice(start + marker.length, end)
  .replace(/\/\/[^\n]*/g, '').split(',').map(entry => entry.trim()).filter(Boolean);
assert(entries.length > 0, 'IPC registry must not be empty');
for (const entry of entries) {
  assert.match(entry, /^\w+(?:::\w+)+$/, `IPC command must name its owning module: ${entry}`);
}
const names = entries.map(entry => entry.split('::').at(-1));
assert.equal(new Set(names).size, names.length, 'IPC command names must be unique');
console.log(`Architecture boundaries OK: ${modules.length} modules, ${entries.length} IPC commands.`);
