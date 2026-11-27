import assert from "node:assert/strict";
import test from "node:test";
import { CHROMIUM_ENV_VAR, resolveChromiumExecutable } from "./playwright-browser-probe.mjs";

const cacheExe = "C:\\Users\\dev\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win\\chrome.exe";
const systemExe = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

function windowsEnv(overrides = {}) {
  return {
    LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
    PROGRAMFILES: "C:\\Program Files",
    ...overrides,
  };
}

test("override wins on every platform and must exist", () => {
  const exists = (candidate) => candidate === "/opt/chrome";
  assert.equal(
    resolveChromiumExecutable({
      platform: "linux",
      env: { [CHROMIUM_ENV_VAR]: "/opt/chrome" },
      exists,
    }),
    "/opt/chrome",
  );
  assert.throws(
    () =>
      resolveChromiumExecutable({
        platform: "win32",
        env: { [CHROMIUM_ENV_VAR]: "C:\\missing\\chrome.exe" },
        exists: () => false,
      }),
    /does not exist/,
  );
});

test("non-Windows platforms keep Playwright's managed browser", () => {
  assert.equal(
    resolveChromiumExecutable({ platform: "darwin", env: {}, exists: () => true }),
    undefined,
  );
  assert.equal(
    resolveChromiumExecutable({ platform: "linux", env: {}, exists: () => true }),
    undefined,
  );
});

test("Windows probes the newest cached Chromium install", () => {
  const discovered = resolveChromiumExecutable({
    platform: "win32",
    env: windowsEnv(),
    exists: (candidate) => candidate === cacheExe,
    readdir: () => ["chromium-1199", "chromium-1234"],
  });
  assert.equal(discovered, cacheExe);
});

test("Windows falls back to a system Chrome install", () => {
  const discovered = resolveChromiumExecutable({
    platform: "win32",
    env: windowsEnv(),
    exists: (candidate) => candidate === systemExe,
    readdir: () => [],
  });
  assert.equal(discovered, systemExe);
});

test("Windows derives the cache root from USERPROFILE when LOCALAPPDATA is absent", () => {
  const discovered = resolveChromiumExecutable({
    platform: "win32",
    env: { USERPROFILE: "C:\\Users\\dev" },
    exists: (candidate) => candidate === cacheExe,
    readdir: () => ["chromium-1234"],
  });
  assert.equal(discovered, cacheExe);
});

test("Windows returns undefined when no browser is installed", () => {
  assert.equal(
    resolveChromiumExecutable({
      platform: "win32",
      env: windowsEnv(),
      exists: () => false,
      readdir: () => [],
    }),
    undefined,
  );
});
