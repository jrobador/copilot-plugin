/**
 * An unregistered flag used to become part of the prompt: `task --help` opened
 * a session and spent a real turn answering the literal text "--help", and a
 * caller that forgot to strip `--wait` paid for that too. Free text that starts
 * with a dash still works -- after `--`.
 */
function unknownOptionError(token) {
  return new Error(
    `Unknown option ${token}. Run the command with --help for its options; if this is part of your prompt, put the text after \`--\`.`
  );
}

export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  // Options that may be repeated (`--add-dir a --add-dir b`); each occurrence
  // is pushed, so the value is always an array, empty when the flag is absent.
  const arrayOptions = new Set(config.arrayOptions ?? []);
  for (const name of arrayOptions) valueOptions.add(name);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const allowUnknown = config.allowUnknown === true;
  const options = {};
  for (const name of arrayOptions) options[name] = [];
  const positionals = [];
  let passthrough = false;

  const setOption = (key, value) => {
    if (arrayOptions.has(key)) options[key].push(value);
    else options[key] = value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        setOption(key, nextValue);
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      if (!allowUnknown) throw unknownOptionError(token);
      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      setOption(key, nextValue);
      index += 1;
      continue;
    }

    if (!allowUnknown) throw unknownOptionError(token);
    positionals.push(token);
  }

  return { options, positionals };
}

/** A backslash escapes only what a shell would need it to escape. */
const ESCAPABLE = new Set(['"', "'", "\\"]);

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      // Anything else keeps its backslash: `C:\Users\me` is a path, not four
      // escape sequences.
      current += ESCAPABLE.has(character) || /\s/.test(character) ? character : `\\${character}`;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

/** Does this text carry a flag a slash command would pass, e.g. `--base main`? */
const PACKED_FLAG = /(^|\s)--?[a-z][a-z0-9-]*(=|\s|$)/i;

/**
 * Claude Code hands a slash command's arguments to the plugin as one
 * string. Re-tokenize it only when it looks like packed flags: a bare prompt
 * ("fix C:\x\y.js") is kept whole, so quotes and backslashes inside it survive
 * regardless of how many other tokens happen to be on the line.
 */
export function normalizeArgv(argv) {
  if (argv.length !== 1) {
    return argv;
  }
  const [raw] = argv;
  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }
  const text = raw.trim();
  if (text.startsWith("-") || PACKED_FLAG.test(text)) {
    return splitRawArgumentString(text);
  }
  return [text];
}
