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
