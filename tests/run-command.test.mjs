import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createWorkspacePolicy } from "../lib/paths.mjs";
import { READ_ONLY, WORKSPACE_WRITE } from "../lib/permissions.mjs";
import { resolveBinary } from "../lib/process.mjs";
import {
  allowedPrograms,
  createRunCommandTool,
  describeCommand,
  executeCommand,
  formatCommandResult,
  looksLikePath,
  planCommand,
  resolveLaunch,
  RUN_COMMAND_SCHEMA,
  scrubEnvironment,
  SHELL_TOOL_NAMES,
  WRITE_PROGRAMS
} from "../lib/run-command.mjs";
import { cleanupDir, createTempWorkspace } from "./helpers.mjs";

const IS_WINDOWS = process.platform === "win32";

let parent;
let ws;
let outside;
let policy;

before(() => {
  parent = createTempWorkspace();
  ws = path.join(parent, "ws");
  outside = path.join(parent, "outside");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.mkdirSync(path.join(ws, ".github", "workflows"), { recursive: true });
  fs.mkdirSync(path.join(ws, ".husky"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(ws, "src", "a.js"), "");
  policy = createWorkspacePolicy(ws);
});
after(() => cleanupDir(parent));

const plan = (program, args, mode = WORKSPACE_WRITE, config = {}) => planCommand({ program, args }, mode, policy, config);
const allowed = (program, args, mode, config) => plan(program, args, mode, config).ok === true;
const refused = (program, args, mode, config) => {
  const result = plan(program, args, mode, config);
  assert.equal(result.ok, false, `expected ${program} ${args.join(" ")} to be refused`);
  return result.reason;
};

describe("allowedPrograms", () => {
  it("gives read-only jobs only git and rg", () => {
    assert.deepEqual(allowedPrograms(READ_ONLY), ["git", "rg"]);
  });

  it("gives write jobs the common toolchains plus configured extras, lowercased", () => {
    const list = allowedPrograms(WORKSPACE_WRITE, { extraPrograms: ["Bun", "bun", "../evil", "ok+name"] });
    assert.deepEqual(list, [...WRITE_PROGRAMS, "bun", "ok+name"]);
  });

  it("ignores extras in read-only mode", () => {
    assert.deepEqual(allowedPrograms(READ_ONLY, { extraPrograms: ["bun"] }), ["git", "rg"]);
  });
});

describe("planCommand: program allowlist", () => {
  it("accepts allowlisted programs case-insensitively", () => {
    assert.ok(allowed("git", ["status"], READ_ONLY));
    assert.ok(allowed("GIT", ["status"], READ_ONLY));
    assert.ok(allowed("rg", ["pattern"], READ_ONLY));
    assert.equal(plan("GIT", ["status"], READ_ONLY).program, "git");
  });

  it("refuses programs outside the read-only allowlist", () => {
    for (const program of ["npm", "node", "ls", "bun"]) {
      assert.match(refused(program, ["--version"], READ_ONLY), /not on the read-only allowlist/);
    }
  });

  it("accepts every write-mode toolchain", () => {
    for (const program of WRITE_PROGRAMS) {
      assert.ok(allowed(program, ["--version"]), program);
    }
  });

  it("refuses paths and odd names as programs", () => {
    for (const program of ["git.exe", "./git", "C:\\x\\git.exe", "/usr/bin/git", "", "  ", "gi t"]) {
      assert.equal(plan(program, ["status"]).ok, false, JSON.stringify(program));
    }
    assert.equal(planCommand({ program: undefined }, WORKSPACE_WRITE, policy).ok, false);
    assert.equal(planCommand({ program: 42 }, WORKSPACE_WRITE, policy).ok, false);
  });

  it("honors extraPrograms only in write mode", () => {
    assert.ok(allowed("bun", ["test"], WORKSPACE_WRITE, { extraPrograms: ["bun"] }));
    assert.equal(allowed("bun", ["test"], READ_ONLY, { extraPrograms: ["bun"] }), false);
    assert.equal(allowed("bun", ["test"], WORKSPACE_WRITE, { extraPrograms: ["../bun"] }), false);
  });
});

describe("planCommand: argument hygiene", () => {
  it("refuses non-array or non-string args", () => {
    assert.match(refused("git", ["status", 5]), /array of strings/);
    assert.match(planCommand({ program: "git", args: "status" }, WORKSPACE_WRITE, policy).reason, /array of strings/);
  });

  it("refuses control characters and oversized input", () => {
    assert.match(refused("git", ["a\0b"]), /control character/);
    assert.match(refused("git", ["a\nb"]), /control character/);
    assert.match(refused("git", ["a\rb"]), /control character/);
    assert.match(refused("git", Array.from({ length: 200 }, () => "x")), /too many arguments/);
    assert.match(refused("git", ["x".repeat(5000)]), /argument too long/);
    assert.match(refused("git", Array.from({ length: 100 }, () => "y".repeat(400))), /too long in total/);
  });

  it("treats missing args as an empty list", () => {
    assert.equal(planCommand({ program: "node" }, WORKSPACE_WRITE, policy).ok, true);
  });
});

describe("planCommand: git", () => {
  it("prepends --no-pager exactly once", () => {
    assert.deepEqual(plan("git", ["status"], READ_ONLY).argv, ["--no-pager", "status"]);
    assert.deepEqual(plan("git", ["--no-pager", "log"], READ_ONLY).argv, ["--no-pager", "log"]);
  });

  it("allows read subcommands in read-only mode", () => {
    const cases = [
      ["log", "--oneline", "-5"],
      ["diff", "--", "src/a.js"],
      ["show", "HEAD:src/a.js"],
      ["blame", "src/a.js"],
      ["grep", "-n", "foo"],
      ["ls-files"],
      ["rev-parse", "HEAD"],
      ["describe"],
      ["shortlog", "-sn"],
      ["cat-file", "-p", "HEAD"],
      ["branch", "--list"],
      ["branch", "-a"],
      ["branch", "--contains=HEAD"],
      ["remote"],
      ["remote", "-v"],
      ["remote", "show", "origin"],
      ["remote", "get-url", "origin"],
      ["remote", "get-url", "--push", "origin"],
      ["log", "-c"],
      ["log", "-C", "--stat"]
    ];
    for (const args of cases) {
      assert.ok(allowed("git", args, READ_ONLY), args.join(" "));
    }
  });

  it("refuses mutating subcommands and forms in read-only mode", () => {
    const cases = [
      [["commit", "-m", "x"], /not available to a read-only job/],
      [["checkout", "."], /not available/],
      [["push"], /not available/],
      [[], /needs a subcommand/],
      [["branch", "foo"], /creates or targets a branch/],
      [["branch", "-d", "foo"], /creates or targets|modifies branches/],
      [["branch", "-D"], /modifies branches/],
      [["branch", "--set-upstream-to=origin/main"], /modifies branches/],
      [["remote", "add", "x", "url"], /may only list/],
      [["remote", "set-url", "origin", "x"], /may only list/],
      [["remote", "get-url", "-v"], /may only list/],
      [["log", "--output=out.txt"], /writes or executes/],
      [["grep", "-O", "foo"], /writes or executes/],
      [["grep", "-Ovim", "foo"], /writes or executes/]
    ];
    for (const [args, pattern] of cases) {
      assert.match(refused("git", args, READ_ONLY), pattern, args.join(" "));
    }
  });

  it("refuses global options before the subcommand in both modes", () => {
    for (const mode of [READ_ONLY, WORKSPACE_WRITE]) {
      for (const args of [
        ["-C", "../x", "status"],
        ["--git-dir=../x", "status"],
        ["--git-dir", "../x", "status"],
        ["-c", "core.pager=x", "log"],
        ["--work-tree=../x", "status"],
        ["--exec-path=../x", "status"],
        ["-p", "log"]
      ]) {
        assert.match(refused("git", args, mode), /global option/, `${mode}: ${args.join(" ")}`);
      }
    }
  });

  it("allows any subcommand in write mode", () => {
    assert.ok(allowed("git", ["commit", "-m", "x"]));
    assert.ok(allowed("git", ["checkout", "-b", "feature"]));
    assert.ok(allowed("git", ["log", "--output=out.txt"]));
  });
});

describe("planCommand: denied flags", () => {
  it("refuses options that relocate a program or evaluate code", () => {
    const cases = [
      ["node", ["-e", "1"]],
      ["node", ["--eval=1"]],
      ["node", ["-p", "1"]],
      ["node", ["-r", "../x", "src/a.js"]],
      ["node", ["--import=../x"]],
      ["node", ["--loader", "x"]],
      ["node", ["-e1"]],
      ["python", ["-c", "1"]],
      ["python", ["-cprint(1)"]],
      ["python3", ["-c", "1"]],
      ["npm", ["--prefix", "../x", "install"]],
      ["npm", ["--prefix=../x"]],
      ["npm", ["-g", "install", "x"]],
      ["npx", ["--userconfig=../n", "x"]],
      ["pnpm", ["-C", "../x", "install"]],
      ["pnpm", ["-C../x", "install"]],
      ["yarn", ["--cwd", "../x"]],
      ["cargo", ["--manifest-path", "../Cargo.toml", "build"]],
      ["cargo", ["--config=../c"]],
      ["go", ["-C", "../x", "build"]],
      ["go", ["build", "-modfile=../m"]],
      ["make", ["-C", "../x"]],
      ["make", ["-C../x"]],
      ["make", ["-f", "../Makefile"]],
      ["make", ["--file=../M"]],
      ["rg", ["--pre", "cat", "foo"]],
      ["rg", ["--pre=cat", "foo"]],
      ["rg", ["--pre-glob=*", "foo"]]
    ];
    for (const [program, args] of cases) {
      assert.match(refused(program, args), /not allowed for|outside the workspace/, `${program} ${args.join(" ")}`);
    }
  });

  it("allows the legitimate neighbours of denied flags", () => {
    assert.ok(allowed("python", ["-m", "pytest"]));
    assert.ok(allowed("node", ["--version"]));
    assert.ok(allowed("node", ["src/a.js"]));
    assert.ok(allowed("npm", ["test"]));
    assert.ok(allowed("npm", ["run", "build", "--", "--watch"]));
    assert.ok(allowed("rg", ["-e", "foo", "src"]));
  });
});

describe("planCommand: path arguments", () => {
  it("only inspects arguments that look like paths", () => {
    assert.equal(looksLikePath("status"), false);
    assert.equal(looksLikePath("--porcelain"), false);
    assert.equal(looksLikePath("HEAD~3"), false);
    assert.equal(looksLikePath("src/a.js"), true);
    assert.equal(looksLikePath("src\\a.js"), true);
    assert.equal(looksLikePath("."), true);
    assert.equal(looksLikePath(".."), true);
    assert.equal(looksLikePath("~"), true);
    assert.equal(looksLikePath("C:foo"), true);
    assert.equal(looksLikePath(""), false);
  });

  it("allows paths inside the workspace", () => {
    for (const args of [["foo", "src/"], ["foo", "."], ["foo", "./src/a.js"], ["foo", "src\\a.js"], ["foo", "--glob=src/**"]]) {
      assert.ok(allowed("rg", args), args.join(" "));
    }
  });

  it("refuses paths outside the workspace, including after `=`", () => {
    const cases = [
      ["foo", "../outside"],
      ["foo", path.join(outside, "x")],
      ["foo", ".."],
      ["foo", "--glob=../x"],
      ["foo", IS_WINDOWS ? "C:\\Windows" : "/etc/passwd"]
    ];
    for (const args of cases) {
      assert.match(refused("rg", args), /outside the workspace/, args.join(" "));
    }
  });

  it("expands ~ before judging it", () => {
    const result = plan("rg", ["foo", "~/.ssh"]);
    if (path.resolve(os.homedir()) === ws) {
      assert.equal(result.ok, true);
    } else {
      assert.equal(result.ok, false);
      assert.match(result.reason, /outside the workspace/);
    }
  });

  it("refuses protected paths in write mode only", () => {
    assert.match(refused("node", [".husky/pre-commit"]), /protected path/);
    assert.match(refused("rg", ["foo", ".github/workflows/ci.yml"]), /protected path/);
    assert.match(refused("rg", ["foo", ".git/config"]), /protected path/);
    assert.ok(allowed("git", ["diff", "--", ".github/workflows/ci.yml"], READ_ONLY));
    assert.ok(allowed("rg", ["foo", ".github/workflows/ci.yml"], READ_ONLY));
  });

  it("accepts a bare root path instead of a policy object", () => {
    assert.equal(planCommand({ program: "rg", args: ["foo", "src"] }, WORKSPACE_WRITE, ws).ok, true);
    assert.equal(planCommand({ program: "rg", args: ["foo", "../outside"] }, WORKSPACE_WRITE, ws).ok, false);
  });
});

describe("describeCommand", () => {
  it("quotes only what needs quoting", () => {
    assert.equal(describeCommand("git", ["log", "--format=%s", "a b", ""]), 'command: git log --format=%s "a b" ""');
    assert.equal(describeCommand("git", []), "command: git");
    assert.equal(plan("git", ["status"], READ_ONLY).request, "command: git status");
  });
});

describe("scrubEnvironment", () => {
  it("drops relocation and injection variables, case-insensitively, and keeps PATH", () => {
    const scrubbed = scrubEnvironment({
      PATH: "/bin",
      Path: "C:\\bin",
      HOME: "/home/x",
      GIT_DIR: "x",
      git_work_tree: "y",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "k",
      NODE_OPTIONS: "--x",
      Npm_Config_Prefix: "p",
      npm_config_registry: "r",
      PYTHONPATH: "z",
      CI: "true"
    });
    assert.equal(scrubbed.PATH, "/bin");
    assert.equal(scrubbed.Path, "C:\\bin");
    assert.equal(scrubbed.HOME, "/home/x");
    assert.equal(scrubbed.CI, "true");
    for (const key of ["GIT_DIR", "git_work_tree", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "NODE_OPTIONS", "Npm_Config_Prefix", "npm_config_registry", "PYTHONPATH"]) {
      assert.equal(key in scrubbed, false, key);
    }
    assert.equal(scrubbed.GIT_TERMINAL_PROMPT, "0");
    assert.equal(scrubbed.GIT_PAGER, "cat");
  });
});

describe("resolveLaunch", () => {
  it("reports a missing program as a failure, not a denial", () => {
    const launch = resolveLaunch({ program: "definitely-missing-xyz", argv: [] });
    assert.equal(launch.ok, false);
    assert.equal(launch.denial, false);
    assert.match(launch.reason, /not found on PATH/);
  });

  it("runs a plain binary directly", () => {
    const launch = resolveLaunch({ program: "node", argv: ["--version"] });
    assert.equal(launch.ok, true);
    assert.equal(launch.via, "direct");
    assert.deepEqual(launch.args, ["--version"]);
  });

  describe("Windows shims", { skip: !IS_WINDOWS }, () => {
    it("runs npm through node and npm-cli.js", () => {
      const launch = resolveLaunch({ program: "npm", argv: ["--version"] });
      assert.equal(launch.ok, true);
      assert.equal(launch.via, "node");
      assert.equal(launch.file, process.execPath);
      assert.match(launch.args[0], /npm-cli\.js$/);
    });

    it("wraps other .cmd shims in cmd.exe with verbatim quoting, and refuses metacharacters", () => {
      const bin = path.join(ws, "bin");
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, "tool.cmd"), "@echo %~1\r\n");
      const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };

      const launch = resolveLaunch({ program: "tool", argv: ["hello"] }, { env });
      assert.equal(launch.ok, true);
      assert.equal(launch.via, "cmd");
      assert.equal(launch.options.windowsVerbatimArguments, true);
      assert.deepEqual(launch.args.slice(0, 3), ["/d", "/s", "/c"]);
      assert.match(launch.args[3], /^""[^"]*tool\.cmd" "hello""$/i);

      const bad = resolveLaunch({ program: "tool", argv: ["a&b"] }, { env });
      assert.equal(bad.ok, false);
      assert.equal(bad.denial, true);
      assert.match(bad.reason, /metacharacter/);
    });
  });
});

describe("executeCommand and the tool handler", () => {
  const script = (name, body) => {
    fs.writeFileSync(path.join(ws, name), body);
    return name;
  };
  const makeTool = (overrides = {}) => {
    const decisions = [];
    const tool = createRunCommandTool({
      mode: WORKSPACE_WRITE,
      policy,
      onDecision: (entry) => decisions.push(entry),
      ...overrides
    });
    return { tool, decisions };
  };

  it("exposes the SDK tool shape", () => {
    const { tool } = makeTool();
    assert.equal(tool.name, "run_command");
    assert.equal(tool.skipPermission, true);
    assert.equal(tool.defer, "never");
    assert.equal(tool.parameters, RUN_COMMAND_SCHEMA);
    assert.equal(RUN_COMMAND_SCHEMA.type, "object");
    assert.deepEqual(RUN_COMMAND_SCHEMA.required, ["program"]);
    assert.match(tool.description, /no pipes/i);
    assert.match(tool.description, /Allowed programs: git, npm/);
    assert.equal(SHELL_TOOL_NAMES.length, 10);
  });

  it("runs git --version and reports the decision", async () => {
    const { tool, decisions } = makeTool();
    const result = await tool.handler({ program: "git", args: ["--version"] });
    assert.equal(result.resultType, "success");
    assert.match(result.textResultForLlm, /git version/);
    assert.match(result.textResultForLlm, /\[exit code 0\]$/);
    assert.equal(result.error, undefined);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].allowed, true);
    assert.equal(decisions[0].kind, "command");
    assert.equal(decisions[0].request, "command: git --version");
    assert.equal(decisions[0].detail.exitCode, 0);
    assert.match(decisions[0].detail.preview, /git version/);
  });

  it("reports a non-zero exit as failure", async () => {
    const { tool } = makeTool();
    const name = script("fail.js", "process.stdout.write('boom'); process.exit(3);\n");
    const result = await tool.handler({ program: "node", args: [name] });
    assert.equal(result.resultType, "failure");
    assert.match(result.textResultForLlm, /boom\n\[exit code 3\]$/);
    assert.equal(result.error, "exit code 3");
  });

  it("refuses through the handler without spawning", async () => {
    const { tool, decisions } = makeTool();
    const result = await tool.handler({ program: "node", args: ["-e", "1"] });
    assert.equal(result.resultType, "denied");
    assert.match(result.textResultForLlm, /^Refused: /);
    assert.equal(decisions[0].allowed, false);
    assert.equal(decisions[0].kind, "command");
  });

  it("refuses a read-only job's attempt at npm", async () => {
    const { tool } = makeTool({ mode: READ_ONLY });
    const result = await tool.handler({ program: "npm", args: ["test"] });
    assert.equal(result.resultType, "denied");
    assert.match(result.textResultForLlm, /read-only allowlist/);
  });

  it("survives garbage input", async () => {
    const { tool } = makeTool();
    for (const input of [undefined, null, "git", 42, { args: ["x"] }]) {
      const result = await tool.handler(input);
      assert.equal(result.resultType, "denied", JSON.stringify(input));
    }
  });

  it("kills the process tree on timeout", async () => {
    const { tool } = makeTool();
    const name = script("sleep.js", "process.stdout.write('started\\n'); setTimeout(() => {}, 60000);\n");
    const started = Date.now();
    const result = await tool.handler({ program: "node", args: [name], timeoutMs: 1500 });
    assert.equal(result.resultType, "timeout");
    assert.match(result.textResultForLlm, /timed out after/);
    assert.ok(Date.now() - started < 15000, "timeout should not wait for the child");
  });

  it("caps output keeping head and tail", async () => {
    const name = script(
      "big.js",
      "process.stdout.write('BEGIN\\n'); for (let i = 0; i < 60000; i++) process.stdout.write('0123456789\\n'); process.stdout.write('END\\n');\n"
    );
    const exec = await executeCommand({ program: "node", argv: [name] }, { cwd: ws, maxOutputBytes: 50 * 1024 });
    assert.equal(exec.resultType, "success");
    assert.ok(exec.truncatedBytes > 0);
    assert.ok(exec.output.length <= 50 * 1024 + 80, `output was ${exec.output.length}`);
    assert.match(exec.output, /^BEGIN\n/);
    assert.match(exec.output, /bytes truncated/);
    assert.match(exec.output, /END\n$/);
  });

  it("scrubs the environment but keeps PATH", async () => {
    const name = script(
      "env.js",
      "process.stdout.write(JSON.stringify({ n: process.env.NODE_OPTIONS ?? null, g: process.env.GIT_DIR ?? null, npm: Object.keys(process.env).filter((k) => /^npm_config_/i.test(k)), path: Boolean(process.env.PATH ?? process.env.Path) }));\n"
    );
    const exec = await executeCommand(
      { program: "node", argv: [name] },
      { cwd: ws, env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096", GIT_DIR: "x", npm_config_prefix: "y" } }
    );
    assert.equal(exec.resultType, "success");
    assert.deepEqual(JSON.parse(exec.output), { n: null, g: null, npm: [], path: true });
  });

  it("closes stdin and runs in the job directory", async () => {
    const name = script(
      "cwd.js",
      "let data = ''; process.stdin.on('data', (c) => { data += c; }); process.stdin.on('end', () => { process.stdout.write(process.cwd() + '|' + data.length); });\n"
    );
    const exec = await executeCommand({ program: "node", argv: [name] }, { cwd: ws, timeoutMs: 10000 });
    assert.equal(exec.resultType, "success");
    assert.equal(exec.output, `${fs.realpathSync.native(ws)}|0`);
  });

  it("runs git status in a repository with the --no-pager argv", async (t) => {
    if (!resolveBinary("git")) {
      t.skip("git not on PATH");
      return;
    }
    const repo = path.join(parent, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const repoPolicy = createWorkspacePolicy(repo);
    const tool = createRunCommandTool({ mode: READ_ONLY, policy: repoPolicy });
    const result = await tool.handler({ program: "git", args: ["status", "--porcelain"] });
    assert.equal(result.resultType, "success");
  });

  it("formats a spawn failure", () => {
    assert.equal(
      formatCommandResult({ exitCode: null, timedOut: false, error: "ENOENT", output: "" }),
      "[failed to start: ENOENT]"
    );
    assert.equal(formatCommandResult({ exitCode: 0, timedOut: false, output: "ok\n" }), "ok\n[exit code 0]");
    assert.equal(formatCommandResult({ exitCode: null, signal: "SIGTERM", timedOut: false, output: "" }), "[terminated by signal SIGTERM]");
  });

  it("reports a missing program as a failure result", async () => {
    const { tool, decisions } = makeTool({ config: { extraPrograms: ["definitely-missing-xyz"] } });
    const result = await tool.handler({ program: "definitely-missing-xyz" });
    assert.equal(result.resultType, "failure");
    assert.match(result.textResultForLlm, /failed to start: definitely-missing-xyz was not found/);
    assert.equal(decisions[0].allowed, true);
    assert.equal(decisions[0].detail.exitCode, null);
  });

  describe("Windows", { skip: !IS_WINDOWS }, () => {
    it("runs npm --version through node", async () => {
      const { tool, decisions } = makeTool();
      const result = await tool.handler({ program: "npm", args: ["--version"] });
      assert.equal(result.resultType, "success");
      assert.match(result.textResultForLlm, /^\d+\.\d+\.\d+/);
      assert.equal(decisions[0].detail.file, process.execPath);
    });

    it("runs a .cmd shim through cmd.exe and refuses metacharacters", async () => {
      const bin = path.join(ws, "bin");
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, "tool.cmd"), "@echo %~1\r\n");
      const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
      const { tool, decisions } = makeTool({ env, config: { extraPrograms: ["tool"] } });

      const ok = await tool.handler({ program: "tool", args: ["hello"] });
      assert.equal(ok.resultType, "success");
      assert.match(ok.textResultForLlm, /^hello/);

      const bad = await tool.handler({ program: "tool", args: ["a&b"] });
      assert.equal(bad.resultType, "denied");
      assert.match(bad.textResultForLlm, /metacharacter/);
      assert.equal(decisions[1].allowed, false);
    });
  });

  it("runs rg when available", async (t) => {
    if (!resolveBinary("rg")) {
      t.skip("rg not on PATH");
      return;
    }
    const { tool } = makeTool({ mode: READ_ONLY });
    const result = await tool.handler({ program: "rg", args: ["--version"] });
    assert.equal(result.resultType, "success");
  });
});
