import { spawnSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdtempSync, mkdirSync, openSync, readSync, closeSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Run after Tauri has finished changing binaries and resources. Never mutate
// the app after the outer signature has been sealed.
if (process.platform !== 'darwin') throw new Error('macOS packaging requires macOS');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv.includes('--debug') ? 'debug' : 'release';
const bundle = path.resolve(process.env.CARGO_TARGET_DIR || path.join(root, 'src-tauri/target'), mode, 'bundle');
const config = JSON.parse(readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const app = path.join(bundle, 'macos', `${config.productName}.app`);
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const appVersion = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' });
if (appVersion.status !== 0 || appVersion.stdout.trim() !== version) {
  throw new Error('App version does not match package.json; rebuild the app before packaging');
}
const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch;
const stem = `${config.productName}_${version}_${arch}`;
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
const magic = new Set(['cffaedfe', 'feedfacf', 'cefaedfe', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
const binaries = [];
const nested = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      walk(file);
      if (/\.(app|framework|xpc|bundle)$/.test(name)) nested.push(file);
    } else if (stat.isFile() && !name.endsWith('.a')) {
      const fd = openSync(file, 'r');
      const header = Buffer.alloc(4);
      try {
        if (readSync(fd, header, 0, 4, 0) === 4 && magic.has(header.toString('hex'))) binaries.push(file);
      } finally { closeSync(fd); }
    }
  }
}
walk(app);
if (!binaries.length) throw new Error('No Mach-O binaries found');
for (const file of [...binaries, ...nested, app]) {
  run('codesign', ['--force', '--sign', '-', '--timestamp=none', file]);
}
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
// Explicitly verify resource executables too; they are sealed as resources by
// the outer bundle rather than necessarily treated as nested code.
for (const file of binaries) run('codesign', ['--verify', '--strict', file]);

const stage = mkdtempSync(path.join(tmpdir(), 'piko-package-'));
try {
  const imageRoot = path.join(stage, 'image');
  mkdirSync(imageRoot);
  run('ditto', [app, path.join(imageRoot, path.basename(app))]);
  // A basic image needs no Finder/AppleScript session, including on CI.
  run('ln', ['-s', '/Applications', path.join(imageRoot, 'Applications')]);
  const dmg = path.join(stage, `${stem}.dmg`);
  const zip = path.join(stage, `${stem}.app.zip`);
  run('hdiutil', ['create', '-volname', config.productName, '-srcfolder', imageRoot, '-ov', '-format', 'UDZO', dmg]);
  run('hdiutil', ['verify', dmg]);
  const mount = path.join(stage, 'mounted');
  mkdirSync(mount);
  run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
  try {
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', path.join(mount, path.basename(app))]);
  } finally { run('hdiutil', ['detach', mount]); }
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
  const extracted = path.join(stage, 'extracted');
  run('ditto', ['-x', '-k', zip, extracted]);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', path.join(extracted, path.basename(app))]);
  for (const [folder, file] of [['dmg', dmg], ['macos', zip]]) {
    mkdirSync(path.join(bundle, folder), { recursive: true });
    copyFileSync(file, path.join(bundle, folder, path.basename(file)));
  }
} finally { rmSync(stage, { recursive: true, force: true }); }
console.log(`Signed ${binaries.length} Mach-O files; packaged ${stem} (ad-hoc, without notarization)`);
