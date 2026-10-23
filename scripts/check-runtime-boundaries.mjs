import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

// Shared infrastructure may depend on generated contracts, never on UI/domain features.
const frontend = new URL('../src/', import.meta.url);
const shared = new URL('lib/', frontend);
for (const file of await readdir(shared)) {
  if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
  const url = new URL(file, shared);
  const contents = await readFile(url, 'utf8');
  const ast = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest);
  function checkImports(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      specifier = node.arguments[0];
    }
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
      const dependency = path.relative(fileURLToPath(frontend),
        path.resolve(path.dirname(fileURLToPath(url)), specifier.text));
      assert(!/^(features|components|hooks)(?:[/\\]|$)/.test(dependency),
        `src/lib/${file} must not depend on UI/domain modules: ${specifier.text}`);
    }
    ts.forEachChild(node, checkImports);
  }
  checkImports(ast);
}
console.log('Frontend shared infrastructure boundaries OK.');

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

// Pi SDK ownership stays in one adapter; domain protocols and permissions must not import it.
const agentDirectory = new URL('../agent/', import.meta.url);
for (const file of await readdir(agentDirectory)) {
  if (!file.endsWith('.mjs') || file.endsWith('.test.mjs') || file === 'sdk-adapter.mjs') continue;
  const contents = await readFile(new URL(file, agentDirectory), 'utf8');
  assert(!/from\s+["']@earendil-works\//.test(contents), `${file} must access the SDK through sdk-adapter.mjs`);
}
