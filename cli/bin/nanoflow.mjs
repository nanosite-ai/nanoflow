#!/usr/bin/env node
// nanoflow / nf entry. The published package ships dist/; in a clone, run `npm run build` first.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const entry = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
if (!existsSync(entry)) {
  process.stderr.write("nanoflow: dist/ is missing. Run `npm run build` in the cli/ folder.\n");
  process.exit(1);
}
const { main } = await import(pathToFileURL(entry).href);
await main(process.argv);
