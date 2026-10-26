import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));

test("macOS deployment requires the ScreenCaptureKit screenshot API baseline", () => {
  assert.equal(config.bundle.macOS.minimumSystemVersion, "14.0");
  const build = readFileSync(new URL("./build.sh", import.meta.url), "utf8");
  assert.match(build, /MACOSX_DEPLOYMENT_TARGET:-14\.0/);
  const capture = readFileSync(new URL("../src-tauri/vendor/xcap/src/macos/capture.rs", import.meta.url), "utf8");
  assert.match(capture, /SCScreenshotManager::captureImageWithFilter/);
  assert.doesNotMatch(capture, /CGWindowListCreateImage/);
});

for (const label of ["panel", "bubble"]) {
  test(`${label} provides a standard resizable desktop window`, () => {
    const window = config.app.windows.find((entry) => entry.label === label);
    for (const property of ["decorations", "resizable", "minimizable", "maximizable", "closable"]) {
      assert.equal(window[property], true, `${label}.${property}`);
    }
    assert.equal(window.skipTaskbar, false);
  });
}


test("pet and capture retain their borderless overlay behavior", () => {
  for (const label of ["pet", "capture"]) {
    const window = config.app.windows.find((entry) => entry.label === label);
    assert.equal(window.decorations, false);
    assert.equal(window.skipTaskbar, true);
    assert.equal(window.resizable, false);
  }
});
