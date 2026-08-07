import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node20",
    dts: true,
    sourcemap: true,
    clean: true,
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    target: "node20",
    sourcemap: true,
    clean: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
