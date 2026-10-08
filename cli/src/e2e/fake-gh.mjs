#!/usr/bin/env node
// A stand-in for the gh CLI in the e2e tests (wired in through NANOFLOW_GH). Each call is appended to
// FAKE_GH_LOG as one JSON line, with the contents of any --body-file / --input file it was handed. The
// answer comes from FAKE_GH_FIXTURES: the first fixture whose `match` tokens all appear in the argv wins;
// no match prints nothing and exits 0.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);

const fileArg = (flag) => {
  const i = args.indexOf(flag);
  const file = i >= 0 ? args[i + 1] : undefined;
  return file && existsSync(file) ? readFileSync(file, "utf8") : undefined;
};

if (process.env.FAKE_GH_LOG) {
  appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify({ args, body: fileArg("--body-file"), input: fileArg("--input") })}\n`);
}

const fixtures = process.env.FAKE_GH_FIXTURES && existsSync(process.env.FAKE_GH_FIXTURES)
  ? JSON.parse(readFileSync(process.env.FAKE_GH_FIXTURES, "utf8"))
  : [];
const hit = fixtures.find((f) => f.match.every((token) => args.includes(token)));

if (hit?.stdout) process.stdout.write(hit.stdout);
if (hit?.stderr) process.stderr.write(hit.stderr);
process.exitCode = hit?.code ?? 0;
