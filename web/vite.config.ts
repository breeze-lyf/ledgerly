import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { config } from "dotenv";
config();
export default defineConfig({
  root: "web",
  base: normalize(process.env.BASE_PATH || "/"),
  plugins: [react()],
  build: { outDir: "dist" },
});
function normalize(s: string) {
  return (
    "/" +
    s.split("/").filter(Boolean).join("/") +
    (s.split("/").filter(Boolean).length ? "/" : "")
  );
}
