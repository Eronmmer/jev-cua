import { defineConfig } from "tsup";

export default defineConfig({
  entry: { server: "src/server.ts" },
  format: ["cjs"],
  platform: "node",
  target: "node24",
  outDir: "mcp",
  clean: true,
  splitting: false,
  sourcemap: false,
  noExternal: [/.*/u],
  outExtension: () => ({ js: ".cjs" }),
});
