#!/usr/bin/env node
// Move the demo's story along from a second terminal: CI results, merges, board moves, new tickets.
// The pane picks changes up on its next GitHub poll; press 🔄 Refresh in it to see them at once.
//
//   node demo/director.mjs ci 24 fail      node demo/director.mjs merge 24
//   node demo/director.mjs status 22 "In progress"      node demo/director.mjs show
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoEnv, parseDir } from "./common.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const dirAt = argv.indexOf("--dir");
const command = dirAt >= 0 ? argv.filter((_, i) => i !== dirAt && i !== dirAt + 1) : argv;
const res = spawnSync(process.execPath, [path.join(HERE, "fake-github.mjs"), "demo", ...command], { env: demoEnv(parseDir(argv)), stdio: "inherit" });
process.exitCode = res.status ?? 1;
