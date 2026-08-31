import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeArgv, parseArgs, splitRawArgumentString } from "../lib/args.mjs";

describe("parseArgs", () => {
  it("parses boolean options", () => {
    const { options, positionals } = parseArgs(["--json", "--write"], {
      booleanOptions: ["json", "write"]
    });
    assert.equal(options.json, true);
    assert.equal(options.write, true);
    assert.deepEqual(positionals, []);
  });

  it("parses value options", () => {
    const { options } = parseArgs(["--model", "gpt-5.4"], {
      valueOptions: ["model"]
    });
    assert.equal(options.model, "gpt-5.4");
  });

  it("parses value options with = syntax", () => {
    const { options } = parseArgs(["--model=gpt-5.4"], {
      valueOptions: ["model"]
    });
    assert.equal(options.model, "gpt-5.4");
  });

  it("collects positionals", () => {
    const { positionals } = parseArgs(["hello", "world"], {});
    assert.deepEqual(positionals, ["hello", "world"]);
  });

  it("supports alias map", () => {
    const { options } = parseArgs(["-m", "gpt-5.4"], {
      valueOptions: ["model"],
      aliasMap: { m: "model" }
    });
    assert.equal(options.model, "gpt-5.4");
  });

  it("stops at --", () => {
    const { positionals } = parseArgs(["--", "--json"], {
      booleanOptions: ["json"]
    });
    assert.deepEqual(positionals, ["--json"]);
  });

  it("throws for missing value option argument", () => {
    assert.throws(() => parseArgs(["--model"], { valueOptions: ["model"] }), /Missing value/);
  });
});

describe("splitRawArgumentString", () => {
  it("splits simple tokens", () => {
    assert.deepEqual(splitRawArgumentString("hello world"), ["hello", "world"]);
  });

  it("handles quoted strings", () => {
    assert.deepEqual(splitRawArgumentString('hello "big world"'), ["hello", "big world"]);
  });

  it("handles single quoted strings", () => {
    assert.deepEqual(splitRawArgumentString("hello 'big world'"), ["hello", "big world"]);
  });

  it("handles escaped characters", () => {
    assert.deepEqual(splitRawArgumentString("hello\\ world"), ["hello world"]);
  });

  it("returns empty for empty input", () => {
    assert.deepEqual(splitRawArgumentString(""), []);
  });

  // Audit M7 / task P1-7. Every backslash used to be treated as an escape and
  // dropped, so a Windows path in a prompt arrived mangled (`C:\a\b` -> `C:ab`).
  it("keeps backslashes that do not escape a quote, a space or another backslash", () => {
    assert.deepEqual(splitRawArgumentString("fix C:\\Users\\me\\app.js"), ["fix", "C:\\Users\\me\\app.js"]);
    assert.deepEqual(splitRawArgumentString("a\\ b"), ["a b"]);
    assert.deepEqual(splitRawArgumentString('say \\"hi\\"'), ["say", '"hi"']);
    assert.deepEqual(splitRawArgumentString("a\\\\b"), ["a\\b"]);
  });
});

// Audit M7 / task P1-7. The plugin re-tokenizes argv only when it receives
// exactly one token, so `task "fix C:\x"` and `task --write "fix C:\x"` used to
// parse the same prompt differently.
describe("normalizeArgv", () => {
  it("re-tokenizes a single packed flag string but never a bare prompt", () => {
    assert.deepEqual(normalizeArgv(["--base main --background"]), ["--base", "main", "--background"]);
    assert.deepEqual(normalizeArgv(["--wait"]), ["--wait"]);
    assert.deepEqual(normalizeArgv(["fix C:\\x\\y.js"]), ["fix C:\\x\\y.js"]);
    assert.deepEqual(normalizeArgv(["--write", "fix C:\\x\\y.js"]), ["--write", "fix C:\\x\\y.js"]);
    assert.deepEqual(normalizeArgv(["look for race conditions"]), ["look for race conditions"]);
    assert.deepEqual(normalizeArgv(["--base main look for race conditions"]), ["--base", "main", "look", "for", "race", "conditions"]);
    assert.deepEqual(normalizeArgv([""]), []);
    assert.deepEqual(normalizeArgv(["   "]), []);
  });
});
