// init, doctor, docs: getting a repo onto nanoflow and keeping the reference current.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { CONFIG_REL, SCHEMA_URL } from "../lib/config.mjs";
import { ghAuthOk, repoSlug } from "../lib/gh.mjs";
import { dryRun } from "../lib/globals.mjs";
import { c, info, result, success } from "../lib/output.mjs";
import { tryRun } from "../lib/proc.mjs";
import { requireRepo, type RepoContext } from "../lib/repo.mjs";

const MARKETPLACE = "nanosite-ai/nanoflow"; // nanoflow by nanosite.ai

const readJson = (file: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** The checks a package.json already has scripts for. */
const checksFrom = (scripts: Record<string, string>, runner: string): Record<string, string> => {
  const pick = (names: string[]): string | undefined => names.find((n) => scripts[n]);
  const out: Record<string, string> = {};
  const typecheck = pick(["typecheck", "tsc", "check-types", "types"]);
  const lint = pick(["lint"]);
  const test = pick(["test", "test:unit"]);
  const e2e = pick(["test:e2e", "e2e"]);
  if (typecheck) out.typecheck = `${runner} run ${typecheck}`;
  if (lint) out.lint = `${runner} run ${lint}`;
  if (test) out.test = `${runner} ${test === "test" ? "test" : `run ${test}`}`;
  if (e2e) out.e2e = `${runner} run ${e2e}`;
  return out;
};

const runnerOf = (root: string): string =>
  existsSync(path.join(root, "pnpm-lock.yaml")) ? "pnpm" : existsSync(path.join(root, "yarn.lock")) ? "yarn" : existsSync(path.join(root, "bun.lockb")) ? "bun" : "npm";

/** The folder whose package.json holds the scripts: the root, else the one first-level folder that has one. */
const packageDirOf = (root: string): string | null => {
  if (existsSync(path.join(root, "package.json"))) return "";
  const subs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules" && existsSync(path.join(root, d.name, "package.json")))
    .map((d) => d.name);
  return subs.length === 1 ? subs[0] : null;
};

/** `cd cli && npm run tsc` for a package in a subfolder (works in sh and cmd.exe alike). */
const inDir = (dir: string, command: string): string => (dir ? `cd ${dir} && ${command}` : command);

export const starterConfig = (repo: RepoContext, opts: { board?: string }): Record<string, unknown> => {
  const root = repo.mainRoot;
  const pkgDir = packageDirOf(root);
  const pkgRoot = path.join(root, pkgDir ?? "");
  const pkg = pkgDir === null ? {} : readJson(path.join(pkgRoot, "package.json"));
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const runner = runnerOf(pkgRoot);
  const main = (tryRun("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: root }) ?? "origin/main").replace(/^origin\//, "");
  const devScript = ["dev", "start"].find((s) => scripts[s]);
  const [owner, num] = (opts.board ?? "").split("/");
  // Only an app with a dev/start script gets a service; a library or CLI repo has nothing to run.
  const app = devScript
    ? { services: [{ name: "app", base: 3000, step: 10, path: "/", open: true, start: { run: inDir(pkgDir ?? "", `${runner} run ${devScript}`) } }], env: { export: { PORT: "{port:app}" } } }
    : { services: [] };
  const checks = Object.fromEntries(Object.entries(checksFrom(scripts, runner)).map(([k, v]) => [k, inDir(pkgDir ?? "", v)]));
  return {
    $schema: SCHEMA_URL,
    mainBranch: main,
    provider: { snapshot: ["nanoflow", "flow", "--json"], local: ["nanoflow", "flow", "--json", "--local"] },
    github: opts.board && owner && Number(num) ? { board: { owner, number: Number(num) } } : {},
    ...app,
    worktree: {
      copy: [".env", ".env.local"].filter((f) => existsSync(path.join(root, f))),
      install: pkgDir === null ? null : inDir(pkgDir, `${runner} install`),
    },
    checks,
    actions: {
      startDev: devScript ? { label: "Start dev", run: ["nanoflow", "up", "--bg"] } : null,
      stopDev: devScript ? { label: "Stop", run: ["nanoflow", "kill"], confirm: true } : null,
      teardown: { label: "Teardown", run: ["nanoflow", "wt", "remove", "{feature}", "--delete-branch", "--yes"], cwd: "main", confirm: true },
      startTask: { label: "Start", prompt: "Start ticket #{ticket} ({title}) with `nanoflow task start {ticket}`, then read the ticket and plan the work." },
      newTicket: { label: "Create", run: ["nanoflow", "ticket", "new", "{title}"], cwd: "main" },
    },
  };
};

/** Offer the mod to everyone who trusts the repo: the marketplace + the plugin enabled in .claude/settings.json. */
const teamSettings = (file: string): Record<string, unknown> => {
  const settings = readJson(file);
  const markets = (settings.extraKnownMarketplaces ?? {}) as Record<string, unknown>;
  const enabled = (settings.enabledPlugins ?? {}) as Record<string, boolean>;
  return {
    ...settings,
    extraKnownMarketplaces: { ...markets, nanoflow: { source: { source: "github", repo: MARKETPLACE } } },
    enabledPlugins: { ...enabled, "nanoflow@nanoflow": true },
  };
};

export const registerSetup = (program: Command): void => {
  program
    .command("init")
    .description("write a starter .claude/nanoflow.json from what the repo has (scripts, lockfile, .env files); --team also offers the mod to teammates")
    .option("--board <owner/number>", "your GitHub Project, e.g. acme/3")
    .option("--team", "add the nanoflow marketplace + plugin to .claude/settings.json")
    .option("--force", "overwrite an existing nanoflow.json")
    .addHelpText("after", "\nExamples:\n  nanoflow init\n  nf init --board acme/3 --team")
    .action((opts: { board?: string; team?: boolean; force?: boolean }, cmd: Command) => {
      const repo = requireRepo();
      const file = path.join(repo.checkoutRoot, CONFIG_REL);
      if (existsSync(file) && !opts.force) throw new Error(`${file} already exists (--force to overwrite).`);
      const config = starterConfig(repo, opts);
      const text = `${JSON.stringify(config, null, 2)}\n`;
      const settingsFile = path.join(repo.checkoutRoot, ".claude", "settings.json");
      if (dryRun(cmd, `would write ${file}:`, text, ...(opts.team ? [`would add the nanoflow marketplace to ${settingsFile}`] : []))) return;
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      if (opts.team) writeFileSync(settingsFile, `${JSON.stringify(teamSettings(settingsFile), null, 2)}\n`);
      result({ file, team: Boolean(opts.team) }, () => {
        success(`wrote ${path.relative(repo.checkoutRoot, file)}: edit services (ports, start commands) and checks to match your app`);
        if (opts.team) success("teammates who trust this repo are offered the nanoflow mod");
        info(c.dim("next: nf doctor, then commit .claude/"));
      });
    });

  program
    .command("doctor")
    .description("check what nanoflow relies on: git, gh + auth, the config, the repo slug, the board")
    .addHelpText("after", "\nExamples:\n  nf doctor\n  nf doctor --json")
    .action(() => {
      const checks: { name: string; ok: boolean; detail: string }[] = [];
      const add = (name: string, ok: boolean, detail: string): void => {
        checks.push({ name, ok, detail });
      };
      const [major, minor] = process.versions.node.split(".").map(Number);
      add("node ≥ 20.12", major > 20 || (major === 20 && minor >= 12), process.versions.node);
      const git = tryRun("git", ["--version"]);
      add("git", Boolean(git), git ?? "not found");
      const ghv = tryRun("gh", ["--version"])?.split("\n")[0];
      add("gh CLI", Boolean(ghv), ghv ?? "not found: https://cli.github.com");
      add("gh auth", Boolean(ghv) && ghAuthOk(), "gh auth login");
      const repo = (() => {
        try {
          return requireRepo();
        } catch {
          return null;
        }
      })();
      add("git repo", Boolean(repo), repo?.mainRoot ?? "run inside a repo");
      if (repo) {
        add("config", Boolean(repo.configFile), repo.configFile ?? "none: defaults in use (nf init writes one)");
        let slug = "";
        try {
          slug = repoSlug(repo);
        } catch (err) {
          slug = (err as Error).message;
        }
        add("GitHub repo", slug.includes("/") && !slug.includes(" "), slug);
        const b = repo.config.github.board;
        if (b) {
          const id = tryRun("gh", ["project", "view", String(b.number), "--owner", b.owner, "--format", "json", "--jq", ".id"]);
          add("board", Boolean(id), id ? `${b.owner}/${b.number}` : `cannot read project ${b.owner}/${b.number} (gh auth refresh -s project)`);
        } else add("board", true, "none configured (optional)");
        // Services are optional: a library or CLI repo has nothing to run.
        add("services", true, repo.config.services.map((s) => s.name).join(", ") || "none (optional: add services for per-worktree ports and nf up)");
      }
      const bad = checks.filter((x) => !x.ok);
      result({ ok: !bad.length, checks }, () => {
        for (const x of checks) info(`${x.ok ? c.ok("✔") : c.err("✖")} ${x.name.padEnd(12)} ${c.dim(x.detail)}`);
      });
      if (bad.length) process.exitCode = 1;
    });
};

// ─── docs ────────────────────────────────────────────────────────────────────

const DOC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "cli.md");
const HELP_WIDTH = 100;

export const helpOf = (cmd: Command): string => {
  let out = "";
  cmd.configureOutput({ writeOut: (s) => (out += s), getOutHelpWidth: () => HELP_WIDTH, getOutHasColors: () => false });
  cmd.outputHelp();
  return out.trimEnd();
};

const pathOf = (cmd: Command): string => {
  const names: string[] = [];
  for (let x: Command | null = cmd; x; x = x.parent) names.unshift(x.name());
  return names.join(" ");
};

export const leafCommands = (root: Command): Command[] => root.commands.flatMap((cmd) => (cmd.commands.length ? leafCommands(cmd) : [cmd]));

export const renderDocs = (root: Command): string => {
  const leaves = leafCommands(root).filter((x) => x.name() !== "help");
  return [
    "<!-- GENERATED by `nanoflow docs --write`. Do not edit by hand. -->",
    "# nanoflow CLI reference",
    "",
    "nanoflow is made by [nanosite.ai](https://nanosite.ai).",
    "",
    "Every command takes `--json` (result on stdout, progress on stderr), `--dry` (print, change nothing) and `--yes` (answer confirmations; required without a TTY). `nf` is a short alias of `nanoflow`.",
    "",
    "| Command | What it does |",
    "|---|---|",
    ...leaves.map((x) => `| [\`${pathOf(x)}\`](#${pathOf(x).replace(/\s+/g, "-")}) | ${x.description()} |`),
    "",
    ...leaves.map((x) => `### ${pathOf(x)}\n\n\`\`\`text\n${helpOf(x)}\n\`\`\`\n`),
  ].join("\n");
};

export const registerDocs = (program: Command): void => {
  program
    .command("docs")
    .description("print (or --write docs/cli.md) the reference for every command")
    .option("--write", "write docs/cli.md")
    .addHelpText("after", "\nExamples:\n  nanoflow docs --write\n  nf docs --json")
    .action((opts: { write?: boolean }) => {
      const root = program;
      if (opts.write) {
        writeFileSync(DOC, renderDocs(root));
        success(`wrote ${DOC}`);
        return;
      }
      result(
        leafCommands(root).filter((x) => x.name() !== "help").map((x) => ({ command: pathOf(x), description: x.description(), options: x.options.map((o) => ({ flags: o.flags, description: o.description })) })),
        () => info(renderDocs(root)),
      );
    });
};
