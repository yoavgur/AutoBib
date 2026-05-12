import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

async function main() {
  await mkdir(dist, { recursive: true });
  await mkdir(path.join(dist, "content"), { recursive: true });

  await build({
    entryPoints: {
      "content/arxiv": path.join(root, "src/content/arxiv.ts"),
      "content/semanticScholar": path.join(
        root,
        "src/content/semanticScholar.ts",
      ),
      "content/googleScholar": path.join(root, "src/content/googleScholar.ts"),
    },
    bundle: true,
    format: "iife",
    target: ["chrome110"],
    outdir: dist,
    sourcemap: true,
    logLevel: "info",
  });

  // Background service worker — runs as ESM (manifest type: "module").
  await build({
    entryPoints: { background: path.join(root, "src/background.ts") },
    bundle: true,
    format: "esm",
    target: ["chrome110"],
    outdir: dist,
    sourcemap: true,
    logLevel: "info",
  });

  // Copy static assets.
  await cp(path.join(root, "manifest.json"), path.join(dist, "manifest.json"));
  await cp(
    path.join(root, "src/content/autobib.css"),
    path.join(dist, "content/autobib.css"),
  );
  if (existsSync(path.join(root, "icons"))) {
    await cp(path.join(root, "icons"), path.join(dist, "icons"), {
      recursive: true,
    });
  }

  console.log("built →", dist);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
