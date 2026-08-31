import path from "node:path";
import { fileURLToPath } from "node:url";

/** The package/plugin root: the dir that holds bin/, lib/, prompts/ and schemas/. */
export const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
