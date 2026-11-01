import dotenv from "dotenv";
import { existsSync, readFileSync } from "node:fs";
dotenv.config();
const secretFile =
  process.env.PAYPAL_ENV_FILE || "/home/box/.secrets/paypal_sandbox.env";
if (existsSync(secretFile)) {
  // A copied .env contains blank credentials; those must not mask the secret file.
  const secrets = dotenv.parse(readFileSync(secretFile));
  for (const [key, value] of Object.entries(secrets))
    if (!process.env[key]) process.env[key] = value;
}
export const base =
  "/" +
  (process.env.BASE_PATH || "/").split("/").filter(Boolean).join("/") +
  ((process.env.BASE_PATH || "/").split("/").filter(Boolean).length ? "/" : "");
export const mock = process.env.PAYPAL_MODE !== "sandbox";
export const llmConfigured = Boolean(
  process.env.DISABLE_LLM !== "1" && process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL,
);

// Refuse production or arbitrary API destinations, including accidental configuration.
export const paypalApiBase = process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";
if (!mock && !["https://api-m.sandbox.paypal.com", "https://api.sandbox.paypal.com"].includes(paypalApiBase))
  throw Error("PAYPAL_API_BASE must be a PayPal sandbox endpoint");
