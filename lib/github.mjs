/**
 * The one place that talks to GitHub.
 *
 * `gh` runs here, in the plugin's own process, and never inside a job. A
 * delegated job is fenced to a workspace and, outside `--write`, is offline on
 * purpose: `gh` is outbound network carrying the user's token, which is the
 * same surface the permission policy closes when it refuses URL fetches. So
 * the pull request is fetched once, up front, and what reaches the model is
 * ordinary prompt text it cannot re-query.
 *
 * Everything crossing this boundary is remote data written by whoever opened
 * the pull request. Ref names are validated by the caller with assertSafeRef
 * before they reach a command line; the title and body are bounded and framed
 * as data before they reach a prompt. Raw `gh` JSON never leaves this module.
 *
 * Pure with respect to the SDK: node built-ins and sibling modules only.
 */

import { runCommand } from "./process.mjs";

/**
 * Exactly what we ask GitHub for. A field that is not here can never reach a
 * prompt, which is the cheapest way to keep the high-injection-surface parts
 * of a pull request (review threads, comments) out by construction.
 *
 * Do not trim this list to save a round trip: `gh pr view <n> --json number`
 * answers from the number you passed it, exit 0, without ever asking GitHub,
 * so a pull request that does not exist comes back looking real. Asking for a
 * field only the API can answer is what makes a bad number fail.
 */
export const GH_PR_FIELDS = Object.freeze([
  "number",
  "title",
  "state",
  "isDraft",
  "isCrossRepository",
  "url",
  "author",
  "baseRefName",
  "headRefName",
  "headRefOid",
  "body"
]);

/** How a caller is told to install the CLI, in the one place it is worded. */
const INSTALL_HINT = "Install it from https://cli.github.com and run `gh auth login`.";

/**
 * `--pr` is the only value this module puts on a command line, so this is its
 * trust boundary -- what assertSafeRef is for a git ref.
 *
 * It is not cosmetic. runCommand turns on a shell when the resolved binary is
 * a `.cmd`/`.bat` shim (see process.mjs), and several Windows installers put a
 * `gh.cmd` on PATH; without this, the value would be re-parsed by cmd.exe.
 * Digits only, and a length cap so the number stays a plausible one.
 *
 * @param {unknown} raw  "12", "#12", or anything a user might type.
 * @returns {number}
 */
export function parsePullRequestNumber(raw) {
  const text = String(raw ?? "").trim();
  if (!/^#?\d{1,9}$/.test(text)) {
    throw new Error(
      `Refusing to use ${JSON.stringify(text)} as a pull request number: pass a positive integer, as in \`--pr 12\`. A full pull request URL is not accepted; it could name a repository other than this one.`
    );
  }
  const value = Number.parseInt(text.replace(/^#/, ""), 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Refusing to use ${JSON.stringify(text)} as a pull request number: it must be 1 or greater.`);
  }
  return value;
}

/**
 * What `gh` said, in words that name the remedy.
 *
 * Classified only by "the binary is not there" versus "it ran and failed",
 * the same split ensureGitRepository makes. Finer classification by exit code
 * was tried and does not hold: an invalid token exits 1, not 4. So any
 * non-zero exit passes gh's own stderr through verbatim after our line --
 * gh usually names the fix itself, and its wording is not ours to predict.
 */
function describeFailure(number, result) {
  const code = result.error && "code" in result.error ? result.error.code : null;
  if (code === "ENOENT") {
    return new Error(`GitHub CLI (gh) is not installed, so \`--pr ${number}\` cannot look up the pull request. ${INSTALL_HINT}`);
  }
  if (result.error) {
    return new Error(`Could not run gh to look up pull request #${number}: ${result.error.message}`);
  }
  const detail = (result.stderr || result.stdout || "").trim();
  return new Error(
    [
      `gh could not read pull request #${number} in this repository.`,
      detail ? `gh said: ${detail}` : null,
      "Check that this directory is a GitHub repository (`git remote -v`), that the number exists (`gh pr list`), and that you are signed in (`gh auth status`)."
    ]
      .filter(Boolean)
      .join(" ")
  );
}

/**
 * Read one pull request. Network, and the only network this plugin does.
 *
 * @param {string} cwd     Directory whose remote identifies the repository.
 * @param {number} number  Already through parsePullRequestNumber.
 * @param {{runCommandImpl?: typeof runCommand}} [options]  Test seam, matching
 *   the optional-impl convention used elsewhere in process.mjs.
 * @returns {{number: number, title: string, state: string, isDraft: boolean,
 *   fork: boolean, url: string, author: string, baseRefName: string,
 *   headRefName: string, headRefOid: string, body: string}}
 */
export function getPullRequest(cwd, number, options = {}) {
  const run = options.runCommandImpl ?? runCommand;
  const result = run("gh", ["pr", "view", String(number), "--json", GH_PR_FIELDS.join(",")], { cwd });

  if (result.error || result.status !== 0) {
    throw describeFailure(number, result);
  }

  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`gh returned output for pull request #${number} that is not valid JSON: ${error.message}`);
  }

  // `gh` answers `number` from the argument without asking GitHub, so a
  // response carrying nothing else is the short-circuit described on
  // GH_PR_FIELDS, not a real pull request.
  if (!data || typeof data !== "object" || typeof data.headRefOid !== "string" || data.headRefOid === "") {
    throw new Error(
      `gh did not return a head commit for pull request #${number}, so there is nothing to review. Check the number with \`gh pr list\`.`
    );
  }

  return {
    number: Number(data.number) || number,
    title: String(data.title ?? ""),
    state: String(data.state ?? "UNKNOWN"),
    isDraft: data.isDraft === true,
    fork: data.isCrossRepository === true,
    url: String(data.url ?? ""),
    author: String(data.author?.login ?? "unknown"),
    baseRefName: String(data.baseRefName ?? ""),
    headRefName: String(data.headRefName ?? ""),
    headRefOid: String(data.headRefOid),
    body: String(data.body ?? "")
  };
}
