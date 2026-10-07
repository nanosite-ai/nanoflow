import { spawn } from "node:child_process";
import { readFileSync, statSync, watchFile } from "node:fs";
import path from "node:path";
import { Option, type Command } from "commander";
import { dryRun, withEnvOptions } from "../lib/globals.mjs";
import { killTree, processesInDir, processesOnPort } from "../lib/kill.mjs";
import { c, info, result, step, success } from "../lib/output.mjs";
import { runShellCapture, tail } from "../lib/proc.mjs";
import { ensureExcluded, requireRepo } from "../lib/repo.mjs";
import { hasLogs, healthUrl, isAlive, isUp, logFile, readStackState, servicesToStart, stopRecordedStack, superviseStack, waitUntilUp } from "../lib/stack.mjs";
import { envForSlot, nameVars, readMeta, slotOf, slotVars } from "../lib/worktree.mjs";
import { resolveSlot } from "./wt.mjs";

interface UpOpts {
  with?: string[];
  bg?: boolean;
  timeout?: string;
  before?: boolean;
  supervise?: boolean;
}

export const registerStack = (program: Command): void => {
  program
    .command("up")
    .description("start this checkout's services on its slot ports, wait until they answer, print the URLs")
    .option("--with <names...>", "also start these optional services")
    .option("--bg", "run detached, logging to <stateDir>/logs/ (see nf logs / nf kill)")
    .option("--timeout <sec>", "how long to wait for the services to answer")
    .option("--no-before", "skip stack.before (e.g. building shared packages)")
    .addOption(new Option("--supervise", "internal: run as the detached --bg supervisor").hideHelp())
    .addHelpText("after", "\nExamples:\n  nf up --bg\n  nf up --bg --with worker\n  nf up            # foreground, Ctrl-C stops everything")
    .action(async (opts: UpOpts, cmd: Command) => {
      const repo = requireRepo();
      const { config, checkoutRoot } = repo;
      const slot = slotOf(config, checkoutRoot);
      const vars = slotVars(config, slot, nameVars(repo, readMeta(config, checkoutRoot)?.feature ?? "main"));
      const services = servicesToStart(config, opts.with ?? []);
      if (!services.length) throw new Error('No services to start. Give a service a "start": { "run": "npm start", "cwd": "." } in .claude/nanoflow.json.');
      const env = envForSlot(config, slot, vars);

      if (opts.supervise) {
        superviseStack({ config, checkoutRoot, services, env, logToFiles: true });
        return;
      }
      const urls = services.flatMap((s) => (s.ready === false ? [] : [healthUrl(config, s, slot)].filter((u): u is URL => u !== null)));
      const urlsLine = services.flatMap((s) => (vars[`origin:${s.name}`] ? [`${s.name} ${vars[`origin:${s.name}`]}`] : [])).join("  |  ");
      info(`${c.bold(`slot ${slot}`)}  ${urlsLine}`);
      info(c.dim(`services: ${services.map((s) => s.name).join(", ")}`));
      if (dryRun(cmd, ...Object.entries(env).map(([k, v]) => `${k}=${v}`))) return;

      const running = readStackState(config, checkoutRoot);
      if ((running && isAlive(running.pid)) || (urls[0] && (await isUp(urls[0])))) {
        throw new Error(`Something already answers on ${urls[0]?.origin ?? "this slot"}: see \`nf status\`, stop it with \`nf kill\`.`);
      }
      if (opts.before !== false) {
        for (const command of config.stack.before) {
          step(command);
          const res = runShellCapture(command, { cwd: checkoutRoot, env });
          if (res.code !== 0) throw new Error(`"${command}" failed:\n${tail(res.output, 30)}`);
        }
      }
      ensureExcluded(repo, [`/${config.stack.stateDir}/`]);
      const timeoutMs = Number(opts.timeout ?? config.stack.timeoutSeconds) * 1000;

      if (!opts.bg) {
        superviseStack({ config, checkoutRoot, services, env, logToFiles: false });
        if (await waitUntilUp(urls, timeoutMs)) success(`ready: ${urlsLine}`);
        return;
      }
      // Re-run ourselves detached as the supervisor; it outlives this process and records its pid.
      spawn(process.execPath, [process.argv[1], "up", "--supervise", ...(opts.with?.length ? ["--with", ...opts.with] : [])], {
        cwd: checkoutRoot,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
      let waited = 0;
      const ok = await waitUntilUp(urls, timeoutMs, (down) => {
        waited += 1;
        if (waited % 5 === 0) info(c.dim(`waiting on ${down.map((u) => u.origin).join(", ")}…`));
      });
      if (!ok) {
        const first = services[0].name;
        const log = hasLogs(config, checkoutRoot, first) ? tail(readFileSync(logFile(config, checkoutRoot, first), "utf8"), 15) : "";
        throw new Error(`The stack didn't answer within ${timeoutMs / 1000}s. Last ${first} log lines:\n${log}\n(nf logs <service>, nf kill)`);
      }
      result({ slot, services: services.map((s) => ({ name: s.name, url: vars[`origin:${s.name}`] ?? null })) }, () =>
        success(`ready: ${urlsLine}  ${c.dim("(nf logs <service> · nf kill)")}`),
      );
    });

  withEnvOptions(program.command("status").description("which of this slot's services answer, and the --bg stack if one runs"))
    .addHelpText("after", "\nExamples:\n  nf status\n  nf status --slot 0 --json")
    .action(async (opts: { slot?: string; wt?: string }) => {
      const repo = requireRepo();
      const { slot, dir } = resolveSlot(repo, opts);
      const services = await Promise.all(
        repo.config.services.flatMap((s) => {
          const url = healthUrl(repo.config, s, slot);
          return url ? [isUp(url).then((up) => ({ name: s.name, url: url.origin, up }))] : [];
        }),
      );
      const stack = dir ? readStackState(repo.config, dir) : null;
      const bg = stack && isAlive(stack.pid) ? stack : null;
      result({ slot, services, bgStack: bg }, () => {
        info(c.bold(`slot ${slot}`));
        for (const s of services) info(`  ${s.up ? c.ok("●") : c.dim("○")} ${s.name.padEnd(12)} ${s.url}`);
        if (bg) info(c.dim(`  bg stack pid ${bg.pid} since ${bg.startedAt}: ${bg.apps.join(", ")}`));
      });
    });

  program
    .command("logs")
    .description("show (or --follow) a service's log from the `nf up --bg` stack")
    .argument("<service>", "a service name from nanoflow.json")
    .option("--tail <n>", "lines to show", "80")
    .option("--grep <text>", "only lines containing this (case-insensitive)")
    .option("--follow", "keep printing new lines")
    .addHelpText("after", "\nExamples:\n  nf logs server\n  nf logs server --grep error --tail 200\n  nf logs web --follow")
    .action((name: string, opts: { tail: string; grep?: string; follow?: boolean }) => {
      const repo = requireRepo();
      const file = logFile(repo.config, repo.checkoutRoot, name);
      if (!hasLogs(repo.config, repo.checkoutRoot, name)) throw new Error(`No log for "${name}" here. Start the stack with \`nf up --bg\`.`);
      const match = (l: string): boolean => !opts.grep || l.toLowerCase().includes(opts.grep.toLowerCase());
      const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(match).slice(-Number(opts.tail));
      result({ file, lines }, () => info(lines.join("\n")));
      if (!opts.follow) return;
      let size = statSync(file).size;
      watchFile(file, { interval: 500 }, (cur) => {
        if (cur.size < size) size = 0; // a restarted stack truncated the log
        const fresh = readFileSync(file, "utf8").slice(size);
        size = cur.size;
        for (const l of fresh.split(/\r?\n/)) if (l && match(l)) info(l);
      });
    });

  program
    .command("kill")
    .description("stop this checkout's dev processes (the --bg stack + anything running from its dir), or a port's owner")
    .argument("[worktree]", "another worktree's folder name (default: this checkout)")
    .option("--port <n>", "stop whatever listens on this port instead")
    .addHelpText("after", "\nExamples:\n  nf kill\n  nf kill myapp-603-redirects\n  nf kill --port 5173")
    .action((target: string | undefined, opts: { port?: string }, cmd: Command) => {
      const repo = requireRepo();
      if (opts.port) {
        const pids = processesOnPort(Number(opts.port));
        if (dryRun(cmd, `would stop pid(s) ${pids.join(", ") || "(none)"} on port ${opts.port}`)) return;
        const killed = killTree(pids);
        result({ port: Number(opts.port), killed }, () => success(killed.length ? `stopped ${killed.join(", ")} on :${opts.port}` : `nothing on :${opts.port}`));
        return;
      }
      const dir = target ? path.resolve(path.dirname(repo.mainRoot), target) : repo.checkoutRoot;
      const pids = processesInDir(dir);
      if (dryRun(cmd, `would stop the bg stack and pid(s) ${pids.join(", ") || "(none)"} running from ${dir}`)) return;
      const killed = [...stopRecordedStack(repo.config, dir), ...killTree(processesInDir(dir))];
      result({ dir, killed }, () => success(killed.length ? `stopped ${killed.length} process(es) in ${path.basename(dir)}` : `nothing running in ${path.basename(dir)}`));
    });
};
