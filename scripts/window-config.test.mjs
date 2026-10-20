import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));

for (const label of ["panel"]) {
  test(`${label} provides a standard resizable desktop window`, () => {
    const window = config.app.windows.find((entry) => entry.label === label);
    for (const property of ["decorations", "resizable", "minimizable", "maximizable", "closable"]) {
      assert.equal(window[property], true, `${label}.${property}`);
    }
    assert.equal(window.skipTaskbar, false);
  });
}

test("quick chat starts lightweight and can expand without a new window", () => {
  const window = config.app.windows.find((entry) => entry.label === "bubble");
  assert.equal(window.decorations, false);
  assert.equal(window.skipTaskbar, true);
  assert.equal(window.resizable, true);
});

test("pet and capture retain their borderless overlay behavior", () => {
  for (const label of ["pet", "capture"]) {
    const window = config.app.windows.find((entry) => entry.label === label);
    assert.equal(window.decorations, false);
    assert.equal(window.skipTaskbar, true);
    assert.equal(window.resizable, false);
  }
});
