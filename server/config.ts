import dotenv from "dotenv";
import { existsSync, readFileSync } from "node:fs";
dotenv.config();
const secretFile =
  process.env.PAYPAL_ENV_FILE || "/home/box/.secrets/paypal_sandbox.env";
if (existsSync(secretFile)) {
  // A copied .env contains blank credentials; those must not mask the secret file.
  const secrets = dotenv.parse(readFileSync(secretFile));
  for (const [key, value] of Object.entries(secrets))
    if (key !== "PAYPAL_MODE" && !process.env[key]) process.env[key] = value;
}
export const base =
  "/" +
  (process.env.BASE_PATH || "/").split("/").filter(Boolean).join("/") +
  ((process.env.BASE_PATH || "/").split("/").filter(Boolean).length ? "/" : "");
export const mock = process.env.PAYPAL_MODE !== "sandbox";
export const llmConfigured = Boolean(
  process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL,
);
