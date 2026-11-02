/*
 * Bundles the plugin into one JavaScript file: dist/plugin/autocode.js (no
 * dependencies beyond OpenCode's runtime). A numbered build (ci/dist.sh)
 * compiles its number in as AUTOCODE_BUILD, as the binary does.
 */
import { resolve } from "node:path"

export async function buildPlugin(
  root = resolve(import.meta.dir, "../.."),
  options: { build?: string; outdir?: string } = {},
): Promise<string> {
  const outdir = options.outdir ?? resolve(root, "dist/plugin")
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "src/index.ts")],
    outdir,
    naming: "autocode.js",
    target: "bun",
    format: "esm",
    define: options.build
      ? { AUTOCODE_BUILD: JSON.stringify(options.build) }
      : undefined,
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error("plugin build failed")
  }
  return resolve(outdir, "autocode.js")
}

if (import.meta.main) console.log(await buildPlugin())
