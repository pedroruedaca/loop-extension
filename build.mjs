import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

const entryPoints = [
  { in: "src/background.ts", out: "background" },
  { in: "src/content/mercadona-content.ts", out: "content/mercadona-content" },
  { in: "src/content/page-hook.ts", out: "content/page-hook" },
  { in: "src/popup/popup.ts", out: "popup/popup" },
];

const options = {
  entryPoints,
  bundle: true,
  outdir: "dist",
  format: "iife",
  target: "chrome120",
  sourcemap: true,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("watching...");
} else {
  await esbuild.build(options);
}

cpSync("manifest.json", "dist/manifest.json");
cpSync("src/popup/popup.html", "dist/popup/popup.html");
