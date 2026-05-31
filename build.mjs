import { build, context } from "esbuild";
import { join } from "path";

const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  platform: "node",
  target: "node18",
  external: ["electron"],
  sourcemap: true,
};

const configs = [
  {
    ...shared,
    entryPoints: ["src/main.ts"],
    outfile: "dist/main.js",
  },
  {
    ...shared,
    entryPoints: ["src/preload.ts"],
    outfile: "dist/preload.js",
  },
];

if (watch) {
  const ctxs = await Promise.all(configs.map((c) => context(c)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("Watching for changes…");
} else {
  await Promise.all(configs.map((c) => build(c)));
  console.log("Build complete");
}
