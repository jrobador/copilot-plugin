import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  canonicalizePath,
  createWorkspacePolicy,
  isInsideWorkspace,
  findOutsidePathsInText,
  isWideRoot,
  resolveAdditionalDirectories
} from "../lib/paths.mjs";
import { cleanupDir, createTempWorkspace } from "./helpers.mjs";

const IS_WINDOWS = process.platform === "win32";

/** A workspace with one real subdirectory, plus a sibling directory outside it. */
function makeFixture() {
  const parent = createTempWorkspace();
  const ws = path.join(parent, "ws");
  const outside = path.join(parent, "outside");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(ws, "src", "index.js"), "// hi\n");
  return { parent, ws, outside };
}

/** Windows 8.3 short name of a directory, or null when the volume has none. */
function shortName(dir) {
  try {
    // cmd's `%~sI` is the classic route, but execFileSync's argument quoting
    // and cmd's own do not compose; the COM object needs no quoting games.
    const script = `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${dir}').ShortPath`;
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true
    }).trim();
    return out && out.toLowerCase() !== dir.toLowerCase() ? out : null;
  } catch {
    return null;
  }
}

describe("isInsideWorkspace", () => {
  let fixture;
  before(() => {
    fixture = makeFixture();
  });
  after(() => cleanupDir(fixture.parent));

  it("accepts a relative path inside the workspace", () => {
    const result = isInsideWorkspace(fixture.ws, "src/index.js");
    assert.equal(result.inside, true);
    assert.equal(result.relative, "src/index.js");
    assert.equal(result.resolved, path.join(fixture.ws, "src", "index.js"));
    assert.equal(result.error, null);
  });

  it("accepts a file that does not exist yet, several directories deep", () => {
    const result = isInsideWorkspace(fixture.ws, "src/new/deep/file.js");
    assert.equal(result.inside, true);
    assert.equal(result.relative, "src/new/deep/file.js");
  });

  it("accepts the workspace root itself", () => {
    const result = isInsideWorkspace(fixture.ws, ".");
    assert.equal(result.inside, true);
    assert.equal(result.relative, "");
    assert.equal(isInsideWorkspace(fixture.ws, fixture.ws).inside, true);
  });

  it("accepts a file named with leading dots", () => {
    assert.equal(isInsideWorkspace(fixture.ws, "..foo").inside, true);
  });

  it("rejects an absolute path outside the workspace", () => {
    const target = path.join(fixture.outside, "x.txt");
    const result = isInsideWorkspace(fixture.ws, target);
    assert.equal(result.inside, false);
    assert.equal(result.relative, null);
    assert.equal(result.resolved, target);
  });

  it("rejects the parent directory and `..` traversal", () => {
    assert.equal(isInsideWorkspace(fixture.ws, "..").inside, false);
    assert.equal(isInsideWorkspace(fixture.ws, "../escape.txt").inside, false);
    assert.equal(isInsideWorkspace(fixture.ws, path.join(fixture.ws, "src", "..", "..", "x")).inside, false);
  });

  it("collapses `..` that stays inside", () => {
    const result = isInsideWorkspace(fixture.ws, "src/../src/index.js");
    assert.equal(result.inside, true);
    assert.equal(result.relative, "src/index.js");
  });

  it("resolves relative paths against the job cwd, not the root", () => {
    const cwd = path.join(fixture.ws, "src");
    assert.equal(isInsideWorkspace(fixture.ws, "../src/index.js", { cwd }).relative, "src/index.js");
    assert.equal(isInsideWorkspace(fixture.ws, "../../outside/x", { cwd }).inside, false);
  });

  it("accepts a root spelled with forward slashes, as git prints it", () => {
    const gitStyle = fixture.ws.split(path.sep).join("/");
    const result = isInsideWorkspace(gitStyle, "src/index.js");
    assert.equal(result.inside, true);
    assert.equal(result.relative, "src/index.js");
  });

  it("expands ~ to the home directory", () => {
    const result = isInsideWorkspace(fixture.ws, "~/.ssh/id_rsa");
    assert.equal(result.resolved, path.join(os.homedir(), ".ssh", "id_rsa"));
    // Only inside if the temp workspace happens to live under $HOME, which it
    // does not on any CI runner we care about; assert on the resolution.
    assert.equal(result.inside, result.resolved.startsWith(fixture.ws));
  });

  it("fails closed on malformed input", () => {
    for (const bad of [undefined, null, 42, "", "   ", "a\0b"]) {
      const result = isInsideWorkspace(fixture.ws, bad);
      assert.equal(result.inside, false, `expected ${JSON.stringify(bad)} to be outside`);
      assert.equal(result.resolved, null);
      assert.ok(result.error, `expected an error for ${JSON.stringify(bad)}`);
    }
  });

  it("accepts a prebuilt policy object", () => {
    const policy = createWorkspacePolicy(fixture.ws);
    assert.equal(policy.rootCanonical, fixture.ws);
    assert.equal(isInsideWorkspace(policy, "src/index.js").inside, true);
    assert.equal(isInsideWorkspace(policy, path.join(fixture.outside, "y")).inside, false);
  });

  describe("Windows", { skip: !IS_WINDOWS }, () => {
    it("ignores case differences", () => {
      const upper = path.join(fixture.ws.toUpperCase(), "src", "INDEX.JS");
      const result = isInsideWorkspace(fixture.ws, upper);
      assert.equal(result.inside, true);
      // The existing part is canonicalized to on-disk casing.
      assert.equal(result.relative, "src/index.js");
    });

    it("accepts mixed separators", () => {
      assert.equal(isInsideWorkspace(fixture.ws, `${fixture.ws}/src\\index.js`).relative, "src/index.js");
    });

    it("rejects another drive letter", () => {
      const drive = path.parse(fixture.ws).root.toUpperCase().startsWith("Z:") ? "Y:" : "Z:";
      assert.equal(isInsideWorkspace(fixture.ws, `${drive}\\x`).inside, false);
    });

    it("rejects a UNC path without touching the network", () => {
      const started = Date.now();
      const result = isInsideWorkspace(fixture.ws, "\\\\server\\share\\x");
      assert.equal(result.inside, false);
      assert.ok(Date.now() - started < 1000, "UNC rejection should not block on a lookup");
    });

    it("rejects the device namespace", () => {
      const result = isInsideWorkspace(fixture.ws, "\\\\.\\PhysicalDrive0");
      assert.equal(result.inside, false);
      assert.match(result.error, /device namespace/);
    });

    it("strips the extended-length prefix", () => {
      assert.equal(isInsideWorkspace(fixture.ws, `\\\\?\\${fixture.ws}\\src\\index.js`).relative, "src/index.js");
      assert.equal(isInsideWorkspace(fixture.ws, `\\\\?\\${fixture.outside}\\x`).inside, false);
    });

    it("sees through an 8.3 short name", (t) => {
      const short = shortName(fixture.ws);
      if (!short) {
        t.skip("volume does not generate 8.3 names");
        return;
      }
      const result = isInsideWorkspace(fixture.ws, path.join(short, "src", "index.js"));
      assert.equal(result.inside, true);
      assert.equal(result.relative, "src/index.js");
      assert.equal(isInsideWorkspace(short, path.join(fixture.outside, "x")).inside, false);
    });
  });

  describe("symlinks", () => {
    it("treats a link inside the workspace that points outside as outside", (t) => {
      const link = path.join(fixture.ws, "link-out");
      try {
        fs.symlinkSync(fixture.outside, link, IS_WINDOWS ? "junction" : "dir");
      } catch {
        t.skip("symlink creation not permitted");
        return;
      }
      const result = isInsideWorkspace(fixture.ws, "link-out/new.txt");
      assert.equal(result.inside, false);
      assert.equal(result.resolved, path.join(fixture.outside, "new.txt"));
    });

    it("treats a link that points back inside as inside", (t) => {
      const link = path.join(fixture.ws, "link-in");
      try {
        fs.symlinkSync(path.join(fixture.ws, "src"), link, IS_WINDOWS ? "junction" : "dir");
      } catch {
        t.skip("symlink creation not permitted");
        return;
      }
      const result = isInsideWorkspace(fixture.ws, "link-in/index.js");
      assert.equal(result.inside, true);
      assert.equal(result.relative, "src/index.js");
    });

    it("canonicalizes a workspace root reached through a link", (t) => {
      const link = path.join(fixture.parent, "ws-link");
      try {
        fs.symlinkSync(fixture.ws, link, IS_WINDOWS ? "junction" : "dir");
      } catch {
        t.skip("symlink creation not permitted");
        return;
      }
      const policy = createWorkspacePolicy(link);
      assert.equal(policy.rootCanonical, fixture.ws);
      assert.equal(isInsideWorkspace(link, path.join(fixture.ws, "src", "index.js")).inside, true);
      assert.equal(isInsideWorkspace(link, path.join(fixture.outside, "x")).inside, false);
    });
  });
});

describe("canonicalizePath", () => {
  it("returns the input joined with the missing tail when nothing exists", () => {
    const root = path.parse(process.cwd()).root;
    const ghost = path.join(root, "definitely-missing-copilot-plugin", "a", "b.txt");
    assert.equal(canonicalizePath(ghost), ghost);
  });
});

describe("isWideRoot", () => {
  it("flags the home directory, its ancestors and filesystem roots", () => {
    const home = os.homedir();
    assert.equal(isWideRoot(home), true);
    assert.equal(isWideRoot(path.dirname(home)), true);
    assert.equal(isWideRoot(path.parse(home).root), true);
    assert.equal(isWideRoot(path.parse(process.cwd()).root), true);
  });

  it("accepts project directories", () => {
    const ws = createTempWorkspace();
    try {
      assert.equal(isWideRoot(ws), false);
    } finally {
      cleanupDir(ws);
    }
    assert.equal(isWideRoot(process.cwd()), false);
  });

  it("fails closed on malformed input", () => {
    assert.equal(isWideRoot(""), true);
    assert.equal(isWideRoot(undefined), true);
    assert.equal(isWideRoot(null), true);
  });
});

describe("additional directories (--add-dir)", () => {
  let fixture;
  before(() => {
    fixture = makeFixture();
    fs.writeFileSync(path.join(fixture.outside, "notes.md"), "# notes\n");
  });
  after(() => cleanupDir(fixture.parent));

  it("puts an added directory inside the fence, relative to itself", () => {
    const policy = createWorkspacePolicy(fixture.ws, fixture.ws, [fixture.outside]);
    const result = isInsideWorkspace(policy, path.join(fixture.outside, "notes.md"));
    assert.equal(result.inside, true);
    assert.equal(result.relative, "notes.md");
    assert.equal(result.root, canonicalizePath(fixture.outside));
  });

  it("leaves the workspace root and everything else judged as before", () => {
    const policy = createWorkspacePolicy(fixture.ws, fixture.ws, [fixture.outside]);
    const inside = isInsideWorkspace(policy, "src/index.js");
    assert.equal(inside.inside, true);
    assert.equal(inside.relative, "src/index.js");
    assert.equal(inside.root, canonicalizePath(fixture.ws));
    assert.equal(isInsideWorkspace(policy, path.join(fixture.parent, "elsewhere.txt")).inside, false);
  });

  it("resolves relative entries and refuses one that is not a directory", () => {
    assert.deepEqual(resolveAdditionalDirectories(["outside"], fixture.parent), [
      path.resolve(fixture.parent, "outside")
    ]);
    assert.deepEqual(resolveAdditionalDirectories(undefined, fixture.parent), []);
    assert.throws(
      () => resolveAdditionalDirectories([path.join(fixture.parent, "nope")], fixture.parent),
      /does not exist/
    );
    assert.throws(
      () => resolveAdditionalDirectories([path.join(fixture.outside, "notes.md")], fixture.parent),
      /is not a directory/
    );
  });
});

describe("findOutsidePathsInText", () => {
  let fixture;
  before(() => {
    fixture = makeFixture();
    fs.writeFileSync(path.join(fixture.outside, "notes.md"), "# notes\n");
  });
  after(() => cleanupDir(fixture.parent));

  it("finds a real path outside the fence, and strips sentence punctuation", () => {
    const target = path.join(fixture.outside, "notes.md");
    const found = findOutsidePathsInText(`please read ${target}, then stop`, fixture.ws);
    assert.equal(found.length, 1);
    assert.equal(found[0].resolved, canonicalizePath(target));
  });

  it("says nothing about paths inside the fence", () => {
    assert.deepEqual(findOutsidePathsInText("open ./src/index.js and src/index.js", fixture.ws), []);
  });

  // A false positive blocks a legitimate prompt, so anything that is not
  // unambiguously a path -- or that does not exist -- is left alone.
  it("ignores prose, URLs and paths that do not exist", () => {
    const cases = [
      "see lib/render.mjs for the details",
      "fetch https://example.com/a/b and parse it",
      "the Foo::bar helper is wrong",
      "write to /dev/null",
      `read ${path.join(fixture.parent, "not-there", "ghost.js")}`
    ];
    for (const text of cases) {
      assert.deepEqual(findOutsidePathsInText(text, fixture.ws), [], text);
    }
  });

  it("caps what it reports, so a pasted stack trace cannot flood the error", () => {
    const target = path.join(fixture.outside, "notes.md");
    const text = Array.from({ length: 30 }, (_, index) => `${target}${index === 0 ? "" : ""} x`).join(" ");
    assert.ok(findOutsidePathsInText(text, fixture.ws, { limit: 2 }).length <= 2);
  });
});
