import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = new URL('../src/', import.meta.url);
const sourceRootPath = fileURLToPath(sourceRoot);
const TRACKED_EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.json']);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const url = new URL(entry.name, directory);
    if (entry.isDirectory()) {
      files.push(...await listFiles(new URL(`${entry.name}/`, directory)));
    } else if (entry.isFile() && TRACKED_EXTENSIONS.has(extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
      files.push(fileURLToPath(url));
    }
  }
  return files;
}

const importPattern = /(?:from\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

function importSpecifiers(contents) {
  return [...contents.matchAll(importPattern)].map((match) => match[1]);
}

function resolveSpecifier(fromFile, specifier, knownFiles) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = /\.(ts|tsx|css|json)$/.test(specifier)
    ? [base]
    : [`${base}.ts`, `${base}.tsx`, `${base}.css`, `${base}.json`, `${base}/index.ts`, `${base}/index.tsx`];
  const hit = candidates.find((candidate) => knownFiles.has(candidate));
  if (!hit && !base.startsWith(sourceRootPath.replace(/\/$/, ''))) return null;
  assert(hit, `${fromFile.slice(sourceRootPath.length)} imports "${specifier}" which does not resolve to a file in src/`);
  return hit;
}

const files = await listFiles(sourceRoot);
const knownFiles = new Set(files);
const isTest = (file) => /\.test\.(ts|tsx)$/.test(file) || /\.typecheck\.ts$/.test(file);
const entries = files.filter((file) => file.endsWith('main.tsx') || isTest(file));
assert(entries.length > 1, 'Expected entry points (main.tsx and tests) under src/');

const reached = new Set();
const queue = [...entries];
while (queue.length > 0) {
  const file = queue.pop();
  if (reached.has(file)) continue;
  reached.add(file);
  if (!['.ts', '.tsx'].includes(extname(file))) continue;
  const contents = await readFile(file, 'utf8');
  for (const specifier of importSpecifiers(contents)) {
    const target = resolveSpecifier(file, specifier, knownFiles);
    if (target && !reached.has(target)) queue.push(target);
  }
}

const orphans = files.filter((file) => !reached.has(file)).map((file) => file.slice(sourceRootPath.length));
assert.deepEqual(orphans, [], `Unreferenced files under src/ (delete them or add an import): ${orphans.join(', ')}`);
console.log(`Frontend reachability OK: ${files.length} files reachable from ${entries.length} entry points.`);
