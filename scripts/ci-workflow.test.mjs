import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const frontend = workflow.split(/^  frontend:\s*$/m)[1]?.split(/^  [\w-]+:\s*$/m)[0];

test("browser verification pins a Playwright-supported Ubuntu image", () => {
  assert.ok(frontend, "frontend job must exist");
  assert.match(frontend, /^    runs-on: ubuntu-24\.04\s*$/m);
  assert.doesNotMatch(frontend, /runs-on: ubuntu-latest/);
  assert.match(frontend, /npx playwright install --with-deps chromium/);
  assert.match(frontend, /npm run test:e2e/);
  assert.match(frontend, /node --test scripts\/ci-workflow\.test\.mjs/);
});

test("native packaged Agent tests install the SDK dependencies first", () => {
  const rust = workflow.split(/^  rust:\s*$/m)[1]?.split(/^  [\w-]+:\s*$/m)[0];
  assert.ok(rust, "native verification job must exist");
  const install = rust.indexOf("npm --prefix agent ci");
  const run = rust.indexOf("npm run test:agent:packaged");
  assert.ok(install >= 0 && run > install, "SDK dependencies must exist before tests import the source adapter");
});

test("native cache regression tests run and stale caches use a new namespace", () => {
  assert.match(frontend, /node --test scripts\/sherpa-cache\.test\.mjs/);
  assert.match(workflow, /key: verify-native-cache-v2-\$\{\{ matrix\.os \}\}/);
});

test("Windows Agent runtime extraction regression test runs in CI", () => {
  assert.match(frontend, /node --test scripts\/node-archive\.test\.mjs/);
});

test("Windows MSVC embeds Common Controls v6 in library test executables too", () => {
  const build = readFileSync(new URL("../src-tauri/build.rs", import.meta.url), "utf8");
  const manifest = readFileSync(new URL("../src-tauri/windows.manifest", import.meta.url), "utf8");
  assert.match(build, /CARGO_CFG_TARGET_OS/);
  assert.match(build, /CARGO_CFG_TARGET_ENV/);
  assert.match(build, /WindowsAttributes::new_without_app_manifest\(\)/);
  assert.match(build, /cargo:rustc-link-arg=\/MANIFEST:EMBED/);
  assert.match(build, /cargo:rustc-link-arg=\/MANIFESTINPUT:/);
  assert.doesNotMatch(build, /cargo:rustc-link-arg-tests=/);
  assert.match(manifest, /name="Microsoft\.Windows\.Common-Controls"/);
  assert.match(manifest, /version="6\.0\.0\.0"/);
});

test("vitest coverage is a required gate and its report is visible", () => {
  assert.match(frontend, /^      - run: npm run test:coverage\s*$/m);
  assert.doesNotMatch(frontend, /^      - run: npm run test\s*$/m);
  assert.match(frontend, /Upload vitest coverage report/);
  assert.match(frontend, /path: coverage\//);
  assert.match(frontend, /if: always\(\)/);
  assert.match(frontend, /node --test scripts\/playwright-browser-probe\.test\.mjs/);
});

test("cargo-audit is a hard gate with no skip switch", () => {
  const security = workflow.split(/^  security:\s*$/m)[1];
  assert.ok(security, "security job must exist");
  assert.match(security, /cargo audit --file src-tauri\/Cargo\.lock/);
  assert.match(security, /cargo audit --file tools\/contracts\/Cargo\.lock/);
  assert.doesNotMatch(security, /continue-on-error:\s*true/);
  assert.match(security, /continue-on-error:\s*false/);
});

test("parallel release builds cannot publish before verification succeeds", () => {
  const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const prepare = release.split(/^  prepare:\s*$/m)[1]?.split(/^  [\w-]+:\s*$/m)[0];
  const build = release.split(/^  build:\s*$/m)[1]?.split(/^  [\w-]+:\s*$/m)[0];
  const publish = release.split(/^  publish:\s*$/m)[1];
  assert.ok(prepare && build && publish);
  assert.doesNotMatch(prepare, /^    needs:/m, "draft preparation should not serialize verification and builds");
  assert.match(build, /^    needs: prepare\s*$/m);
  assert.match(publish, /^    needs: \[verify, prepare, build\]\s*$/m, "verification and every platform build must gate public release");
  assert.doesNotMatch(publish, /^    if:.*always\(/m, "failed prerequisites must not be bypassed");
  assert.match(publish, /gh release edit .*--draft=false/);
});
