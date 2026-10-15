import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeScope,
  scopeVisible,
  visibleScopes,
} from "../dist/domain/brain/record-scope.js";

test("normalizeScope maps every spelling to one scope and state", () => {
  const table = [
    [undefined, "global", "defaulted"],
    ["", "global", "defaulted"],
    ["  ", "global", "defaulted"],
    ["global", "global", "declared"],
    ["project:a", "project:a", "declared"],
    ["project:ocean-language", "project:ocean-language", "declared"],
    ["ocean", "invalid", "invalid"],
    ["project:", "invalid", "invalid"],
    ["project:Ocean", "invalid", "invalid"],
    ["project:../x", "invalid", "invalid"],
    ["project:a/b", "invalid", "invalid"],
    ["Global", "invalid", "invalid"],
  ];
  for (const [raw, scope, state] of table)
    assert.deepEqual(
      normalizeScope(raw),
      { scope, state },
      JSON.stringify(raw),
    );
});

test("visibility: bound sees global and its own project; unbound sees global only", () => {
  assert.deepEqual(visibleScopes(null), ["global"]);
  assert.deepEqual(visibleScopes("a"), ["global", "project:a"]);
  assert.equal(scopeVisible("global", null), true);
  assert.equal(scopeVisible("project:a", null), false);
  assert.equal(scopeVisible("global", "a"), true);
  assert.equal(scopeVisible("project:a", "a"), true);
  assert.equal(scopeVisible("project:b", "a"), false);
  assert.equal(scopeVisible("invalid", "a"), false);
  assert.equal(scopeVisible("invalid", null), false);
});
