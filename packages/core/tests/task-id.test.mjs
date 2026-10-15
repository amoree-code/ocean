import assert from "node:assert/strict";
import test from "node:test";
import {
  derivePrefix,
  extractTaskIds,
  formatTaskId,
  isValidPrefix,
  parseTaskId,
  taskIdSpellings,
} from "../dist/domain/tasks/task-id.js";

test("parseTaskId reads any case and normalises the prefix", () => {
  assert.deepEqual(parseTaskId("T-45"), { prefix: "T", number: 45 });
  assert.deepEqual(parseTaskId("t-045"), { prefix: "T", number: 45 });
  assert.deepEqual(parseTaskId("ol-1"), { prefix: "OL", number: 1 });
  for (const bad of ["", "T", "T-", "T-x", "1-2", "TOOLONGX-1", "T-1234567"])
    assert.equal(parseTaskId(bad), null, bad);
});

test("formatTaskId pads to three digits and keeps longer numbers", () => {
  assert.equal(formatTaskId("OL", 1), "OL-001");
  assert.equal(formatTaskId("T", 267), "T-267");
  assert.equal(formatTaskId("T", 1234), "T-1234");
});

test("taskIdSpellings covers padded and unpadded forms, deduplicated", () => {
  assert.deepEqual(taskIdSpellings("T-3"), ["T-3", "T-003"]);
  assert.deepEqual(taskIdSpellings("T-003"), ["T-003", "T-3"]);
  assert.deepEqual(taskIdSpellings("T-267"), ["T-267"]);
  assert.deepEqual(taskIdSpellings("nope"), ["nope"]);
});

test("extractTaskIds: T stays case-insensitive, other prefixes must be registered", () => {
  assert.deepEqual(extractTaskIds("show t-45"), ["T-45"]);
  assert.deepEqual(extractTaskIds("show OL-001"), []);
  assert.deepEqual(extractTaskIds("show OL-001", ["T", "OL"]), ["OL-001"]);
  assert.deepEqual(extractTaskIds("T-2 and OL-3", ["T", "OL"]), [
    "T-2",
    "OL-3",
  ]);
});

test("extractTaskIds never matches look-alikes", () => {
  const prefixes = [
    "T",
    "OL",
    "UTF",
    "SHA",
    "ISO",
    "GPT",
    "PR",
    "bad prefix",
    "(x)",
  ];
  for (const text of [
    "UTF-8",
    "SHA-256",
    "ISO-8601",
    "GPT-5",
    "PR-123",
    "TASK-123",
    "ol-1",
  ])
    assert.deepEqual(extractTaskIds(`see ${text} now`, prefixes), [], text);
});

test("derivePrefix: initials, first three letters, dedupe and reserved", () => {
  assert.equal(derivePrefix("ocean-language"), "OL");
  assert.equal(derivePrefix("dashboard"), "DAS");
  assert.equal(derivePrefix("ocean-language", ["OL"]), "OL2");
  assert.equal(derivePrefix("ocean-language", ["OL", "OL2"]), "OL3");
  assert.equal(derivePrefix("t"), "T2");
  assert.equal(derivePrefix("sha"), "SHA2");
  assert.equal(derivePrefix("42-dashboard"), "DAS");
  assert.equal(derivePrefix("1234"), "P");
  assert.equal(derivePrefix("a-b-c-d-e-f-g-h"), "ABCDEF");
  assert.ok(derivePrefix("abcdef-ghijkl", ["AG"]).length <= 6);
});

test("isValidPrefix rejects bad shapes and reserved prefixes", () => {
  for (const ok of ["T", "OL", "DAS", "AB12"])
    assert.equal(isValidPrefix(ok), true);
  for (const bad of [
    "",
    "ol",
    "1A",
    "TOOLONGX",
    "UTF",
    "SHA",
    "ISO",
    "GPT",
    "A-B",
  ])
    assert.equal(isValidPrefix(bad), false, bad);
});
