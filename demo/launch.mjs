#!/usr/bin/env node
// Start Claude Code inside the demo repo with the nanoflow plugin from this checkout and GitHub faked.
// `nf` / `nanoflow` resolve to the same CLI the pane uses, through shims put first on PATH.
//
//   node demo/launch.mjs [--dir C:\demo] [-- <extra claude args>]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoEnv, DEMO, nanoflowBin, parseDir } from "./common.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const DIR = parseDir(argv);
const SHOP = path.join(DIR, DEMO.repoDir);
if (!existsSync(SHOP)) throw new Error(`No demo in ${DIR}: run node demo/setup.mjs first.`);

const shims = path.join(DIR, ".bin");
mkdirSync(shims, { recursive: true });
for (const name of ["nf", "nanoflow"]) {
  writeFileSync(path.join(shims, `${name}.cmd`), `@"${process.execPath}" "${nanoflowBin()}" %*\r\n`);
  writeFileSync(path.join(shims, name), `#!/bin/sh\nexec "${process.execPath}" "${nanoflowBin()}" "$@"\n`, { mode: 0o755 });
}

const env = demoEnv(DIR);
delete env.NO_COLOR; // colors on for the camera
env.PATH = `${shims}${path.delimiter}${env.PATH ?? env.Path ?? ""}`;
if (env.Path) env.Path = env.PATH;

const extra = argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : [];
const res = spawnSync("claude", ["--plugin-dir", path.resolve(HERE, ".."), ...extra], { cwd: SHOP, env, stdio: "inherit" });
process.exitCode = res.status ?? 1;
