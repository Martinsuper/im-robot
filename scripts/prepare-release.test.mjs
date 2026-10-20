import assert from "node:assert/strict";
import test from "node:test";
import { prepareRelease } from "./prepare-release.mjs";

/** Record GitHub CLI calls without touching real releases. */
function mockApi(responses) {
  const calls = [];
  return {
    calls,
    run(command, args, options) {
      assert.equal(command, "gh");
      calls.push({ args, options });
      assert.ok(responses.length, "Unexpected API call");
      return responses.shift();
    },
  };
}

test("404 JSON on stdout means no existing release, not a published release", () => {
  const api = mockApi([
    { status: 1, stdout: '{"message":"Not Found","status":"404"}', stderr: "gh: Not Found (HTTP 404)" },
    { status: 0, stdout: '{"id":42,"draft":true}' },
  ]);
  assert.equal(prepareRelease("owner/repo", "1.2.12", api.run), 42);
  const payload = JSON.parse(api.calls[1].options.input);
  assert.equal(payload.tag_name, "v1.2.12");
  assert.equal(payload.draft, true);
});

test("published releases are never deleted", () => {
  const api = mockApi([{ status: 0, stdout: '{"id":12,"draft":false}' }]);
  assert.throws(() => prepareRelease("owner/repo", "1.2.12", api.run), /already published/);
  assert.equal(api.calls.length, 1);
});

test("an existing draft is reused without deleting uploaded assets", () => {
  const api = mockApi([{ status: 0, stdout: '{"id":12,"draft":true}' }]);
  assert.equal(prepareRelease("owner/repo", "1.2.12", api.run), 12);
  assert.equal(api.calls.length, 1);
});

for (const status of [401, 403, 500]) {
  test(`HTTP ${status} aborts instead of creating a release`, () => {
    const api = mockApi([{ status: 1, stdout: "{}", stderr: `gh: failure (HTTP ${status})` }]);
    assert.throws(() => prepareRelease("owner/repo", "1.2.12", api.run), /failure/);
    assert.equal(api.calls.length, 1);
  });
}

test("a failed create request is reported", () => {
  const api = mockApi([
    { status: 1, stdout: "{}", stderr: "gh: Not Found (HTTP 404)" },
    { status: 1, stdout: "{}", stderr: "gh: Forbidden (HTTP 403)" },
  ]);
  assert.throws(() => prepareRelease("owner/repo", "1.2.12", api.run), /Forbidden/);
});

test("malformed release metadata fails closed", () => {
  const api = mockApi([{ status: 0, stdout: '{"message":"invalid"}' }]);
  assert.throws(() => prepareRelease("owner/repo", "1.2.12", api.run), /Invalid release/);
  assert.equal(api.calls.length, 1);
});
