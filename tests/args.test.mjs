import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "../plugins/copilot/scripts/lib/args.mjs";

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
});
