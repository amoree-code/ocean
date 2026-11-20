import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Checker } from "@ocean/services/hygiene/hygiene.js";

// The memory-hygiene checkers (T-322, C1): a path on disk, a URL's HEAD, a repo through the
// owner's `gh`. Only a definite "not there" (no file, 404/410, no such repo) is drift; anything
// a check cannot settle (offline, 403, timeout) is unverifiable.

const TIMEOUT_MS = 10_000;

const checkPath: Checker = async ({ value }) => {
  const resolved = value.startsWith("~/")
    ? path.join(os.homedir(), value.slice(2))
    : value;
  return access(resolved).then(
    () => "ok",
    () => "missing",
  );
};

const checkUrl: Checker = async ({ value }) => {
  const request = (method: string) =>
    fetch(value, {
      method,
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "ocean-hygiene" },
    });
  try {
    let response = await request("HEAD");
    if (response.status === 405) response = await request("GET");
    if (response.ok) return "ok";
    return response.status === 404 || response.status === 410
      ? "missing"
      : "unknown";
  } catch {
    return "unknown";
  }
};

const checkRepo: Checker = ({ value }) =>
  new Promise((resolve) => {
    execFile(
      "gh",
      ["repo", "view", value, "--json", "name"],
      { timeout: TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (!error) resolve("ok");
        else
          resolve(
            /could not resolve to a repository/i.test(String(stderr))
              ? "missing"
              : "unknown",
          );
      },
    );
  });

export const claimChecker: Checker = (claim) =>
  claim.kind === "path"
    ? checkPath(claim)
    : claim.kind === "url"
      ? checkUrl(claim)
      : checkRepo(claim);
