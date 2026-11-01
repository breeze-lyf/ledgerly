import "../server/config.js";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
const path = resolve(process.env.DB_PATH || "./data/app.db");
for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
console.log(`Reset ${path}. Stop the app before resetting.`);
if (process.argv.includes("--seed")) await import("./seed.js");
