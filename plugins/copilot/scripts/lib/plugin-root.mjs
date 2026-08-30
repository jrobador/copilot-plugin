import path from "node:path";
import { fileURLToPath } from "node:url";

/** The plugin directory: the one that holds scripts/, prompts/ and schemas/. */
export const ROOT_DIR = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
