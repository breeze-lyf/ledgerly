import dotenv from "dotenv";
import { existsSync } from "node:fs";
dotenv.config();
const secretFile =
  process.env.PAYPAL_ENV_FILE || "/home/box/.secrets/paypal_sandbox.env";
if (existsSync(secretFile)) dotenv.config({ path: secretFile });
export const base =
  "/" +
  (process.env.BASE_PATH || "/").split("/").filter(Boolean).join("/") +
  ((process.env.BASE_PATH || "/").split("/").filter(Boolean).length ? "/" : "");
export const mock = process.env.PAYPAL_MODE !== "sandbox";
export const llmConfigured = Boolean(
  process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL,
);
