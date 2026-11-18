import assert from "node:assert/strict";
import test from "node:test";
import { cleanTitle } from "@ocean/core/shared/clean-title.js";

// T-317: session and digest titles came out as `<browser_instruction># Claude in Chrome …`.
test("a title drops the harness's tags, closed or cut short, and falls back to the project", () => {
  assert.equal(
    cleanTitle(
      "<system-reminder>linked sessions now</system-reminder> Fix the login bug",
      "ocean",
    ),
    "Fix the login bug",
  );
  // The turn was cut at 200 characters, so the tag never closes: all of it is the harness's.
  assert.equal(
    cleanTitle(
      "<browser_instruction># Claude in Chrome browser automation You have access to",
      "ocean",
    ),
    "ocean",
  );
  assert.equal(
    cleanTitle(
      '<ide_opened_file path="/x/a.ts">The user opened a.ts</ide_opened_file>',
      "shop",
    ),
    "shop",
  );
  assert.equal(
    cleanTitle(
      "<command-name>/review</command-name> <command-args>#42</command-args>",
      "ocean",
    ),
    "/review #42",
  );
  assert.equal(cleanTitle("# Plain request", "ocean"), "Plain request");
  assert.equal(cleanTitle("x".repeat(300), "ocean").length, 120);
});
