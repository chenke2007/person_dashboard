import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { workbenchApiPlugin } from "./server/vite-plugin-workbench.mjs";

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), ""), ...process.env };
  const profile = env.PERSONAL_DASHBOARD_PROFILE || "default";
  const readOnly = env.PERSONAL_DASHBOARD_READ_ONLY === "true" || (profile === "obsidian" && env.PERSONAL_DASHBOARD_READ_ONLY !== "false");
  const projectReadOnly = env.WORKBENCH_PROJECTS_READ_ONLY === "true";
  return {
  define: {
    "import.meta.env.VITE_WORKBENCH_PROFILE": JSON.stringify(profile),
    "import.meta.env.VITE_WORKBENCH_READ_ONLY": JSON.stringify(String(readOnly)),
  },
  cacheDir: process.env.VITE_CACHE_DIR || "node_modules/.vite",
  build: {
    outDir: "dist/client",
    emptyOutDir: false,
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    // This server exposes local Vault reads, note persistence, and a confirmed
    // Codex write action. Keep it loopback-only by default.
    host: "127.0.0.1",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react(), workbenchApiPlugin({ vaultRoot: env.PERSONAL_DASHBOARD_VAULT_ROOT || undefined, profile, readOnly, projectReadOnly, knowledgeOptions: { env } })],
  };
});
