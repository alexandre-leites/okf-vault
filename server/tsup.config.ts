import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  dts: true,
  sourcemap: true,
  clean: true,
  minify: false,
  splitting: false,
});
