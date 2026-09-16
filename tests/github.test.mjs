import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getPullRequest, GH_PR_FIELDS, parsePullRequestNumber } from "../lib/github.mjs";

/** A gh that never runs: records what it was asked, replies from a script. */
function fakeGh(reply) {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      command,
      args,
      status: reply.status ?? 0,
      signal: null,
      stdout: reply.stdout ?? "",
      stderr: reply.stderr ?? "",
      error: reply.error ?? null
    };
  };
  return { run, calls };
}

const PR_JSON = JSON.stringify({
  number: 12,
  title: "Add retry to the uploader",
  state: "OPEN",
  isDraft: false,
  isCrossRepository: true,
  url: "https://github.com/o/r/pull/12",
  author: { login: "someone" },
  baseRefName: "main",
  headRefName: "retry",
  headRefOid: "a".repeat(40),
  body: "Fixes the flake."
});

describe("github: parsePullRequestNumber", () => {
  it("accepts a bare number and a #-prefixed one", () => {
    assert.equal(parsePullRequestNumber("12"), 12);
    assert.equal(parsePullRequestNumber("#12"), 12);
    assert.equal(parsePullRequestNumber(" 7 "), 7);
  });

  // This is the trust boundary for the one value --pr puts on a command line.
  // runCommand turns on a shell for a .cmd shim, and Windows installers ship
  // a gh.cmd, so anything but digits has to die here.
  it("refuses everything that is not a plain positive integer", () => {
    for (const bad of [
      "",
      "0",
      "-1",
      "abc",
      "1e3",
      "12 && calc",
      "12;calc",
      "$(id)",
      "9999999999999",
      "https://github.com/o/r/pull/12",
      null,
      undefined
    ]) {
      assert.throws(() => parsePullRequestNumber(bad), /pull request number/, `accepted ${JSON.stringify(bad)}`);
    }
  });
});

describe("github: getPullRequest", () => {
  it("passes the number as its own digits-only argument and asks for every field", () => {
    const gh = fakeGh({ stdout: PR_JSON });
    getPullRequest("/repo", 12, { runCommandImpl: gh.run });

    assert.equal(gh.calls.length, 1);
    assert.deepEqual(gh.calls[0].args, ["pr", "view", "12", "--json", GH_PR_FIELDS.join(",")]);
    // Never interpolated into a larger string: a future refactor that builds
    // `pr view #${n}` would reopen the shim hole parsePullRequestNumber closes.
    assert.match(gh.calls[0].args[2], /^\d+$/);
    assert.equal(gh.calls[0].options.cwd, "/repo");
  });

  it("asks for a field only the API can answer", () => {
    // `gh pr view <n> --json number` answers from the argument, exit 0,
    // without contacting GitHub, so a number that does not exist comes back
    // looking real. Requesting head data is what makes a bad number fail.
    assert.ok(GH_PR_FIELDS.includes("headRefOid"));
    assert.ok(GH_PR_FIELDS.length > 1);
  });

  it("normalizes the response and never leaks raw gh JSON", () => {
    const gh = fakeGh({ stdout: PR_JSON });
    const pr = getPullRequest("/repo", 12, { runCommandImpl: gh.run });

    assert.equal(pr.number, 12);
    assert.equal(pr.author, "someone");
    assert.equal(pr.fork, true);
    assert.equal(pr.baseRefName, "main");
    assert.equal(pr.headRefOid, "a".repeat(40));
    // `author` arrives as an object from gh and must not survive as one.
    assert.equal(typeof pr.author, "string");
  });

  it("reports a missing gh as a missing install, with the remedy", () => {
    const gh = fakeGh({ error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) });
    assert.throws(
      () => getPullRequest("/repo", 12, { runCommandImpl: gh.run }),
      /GitHub CLI \(gh\) is not installed[\s\S]*cli\.github\.com/
    );
  });

  // gh's own exit codes do not distinguish auth from a bad number: an invalid
  // token exits 1, the same as a pull request that does not exist. So any
  // non-zero exit passes gh's stderr through instead of guessing.
  it("passes gh's own words through for any non-zero exit", () => {
    const gh = fakeGh({ status: 1, stderr: "HTTP 401: Bad credentials\nTry authenticating with:  gh auth login" });
    assert.throws(
      () => getPullRequest("/repo", 12, { runCommandImpl: gh.run }),
      /gh auth login/
    );

    const missing = fakeGh({ status: 1, stderr: "GraphQL: Could not resolve to a PullRequest with the number of 999999." });
    assert.throws(
      () => getPullRequest("/repo", 999999, { runCommandImpl: missing.run }),
      /Could not resolve to a PullRequest[\s\S]*gh pr list/
    );
  });

  it("refuses a response with no head commit instead of reviewing nothing", () => {
    const gh = fakeGh({ stdout: JSON.stringify({ number: 999999 }) });
    assert.throws(() => getPullRequest("/repo", 999999, { runCommandImpl: gh.run }), /did not return a head commit/);
  });

  it("refuses output that is not JSON", () => {
    const gh = fakeGh({ stdout: "not json at all" });
    assert.throws(() => getPullRequest("/repo", 12, { runCommandImpl: gh.run }), /not valid JSON/);
  });
});
