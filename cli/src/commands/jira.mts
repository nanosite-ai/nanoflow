import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { acliStatus, credentialsFile, jiraClient, resetAcliStatus, RestJira, saveJiraCreds, siteKey } from "../lib/jira.mjs";
import { c, info, result, success } from "../lib/output.mjs";
import { runInherit } from "../lib/proc.mjs";
import { ask, secret } from "../lib/prompt.mjs";
import { requireRepo } from "../lib/repo.mjs";

/** The repo's Jira site, or --site. */
const siteOf = (opt: string | undefined): string => {
  if (opt) return siteKey(opt);
  const { config } = requireRepo();
  if (!config.jira.site) throw new Error('No Jira site: set "jira": { "site": "https://acme.atlassian.net" } in .claude/nanoflow.json, or pass --site.');
  return siteKey(config.jira.site);
};

/** Save an API token after checking it works: the fallback for CI and machines without acli. */
const tokenLogin = async (site: string, opts: { email?: string; tokenStdin?: boolean }): Promise<void> => {
  const email = opts.email ?? (await ask(`Atlassian email for ${site}`, "--email"));
  const token = opts.tokenStdin ? readFileSync(0, "utf8").trim() : await secret(`API token (https://id.atlassian.com/manage-profile/security/api-tokens)`, "--token-stdin");
  if (!email || !token) throw new Error("Both an email and an API token are needed.");
  const { config } = requireRepo();
  const who = await new RestJira(config, site, { email, token }).myself();
  const file = saveJiraCreds(site, { email, token });
  result({ site, via: "token", user: who, file }, () => success(`logged in to ${site} as ${who} (API token saved in ${file})`));
};

export const registerJira = (program: Command): void => {
  const jira = program.command("jira").description('Jira access for repos with ticket.tracker "jira": through acli (like gh for GitHub), or an API token');

  jira
    .command("login")
    .description("log in to the repo's Jira: acli's browser login (acli keeps it), or --token to save an API token instead")
    .option("--site <url>", "Jira site (default: jira.site in nanoflow.json)")
    .option("--token", "use an Atlassian API token instead of acli (CI, or no acli)")
    .option("--email <email>", "with --token: your Atlassian account email")
    .option("--token-stdin", "with --token: read the token from stdin instead of prompting")
    .addHelpText(
      "after",
      [
        "",
        "acli is Atlassian's CLI: https://developer.atlassian.com/cloud/acli/guides/install-acli/",
        "API tokens: https://id.atlassian.com/manage-profile/security/api-tokens. In CI, export",
        "JIRA_EMAIL + JIRA_API_TOKEN instead (they win over acli and the saved token).",
        "",
        "Examples:",
        "  nf jira login",
        "  nf jira login --token",
        "  nf jira login --token --email me@acme.com --token-stdin < token.txt",
      ].join("\n"),
    )
    .action(async (opts: { site?: string; token?: boolean; email?: string; tokenStdin?: boolean }) => {
      const site = siteOf(opts.site);
      if (opts.token || opts.tokenStdin) return tokenLogin(site, opts);
      const before = await acliStatus();
      if (!before.installed) {
        throw new Error("acli is not installed: https://developer.atlassian.com/cloud/acli/guides/install-acli/ (or `nf jira login --token` with an API token).");
      }
      // acli's own browser login, in this terminal: it asks which site, and keeps the login itself.
      info(`acli jira auth login --web  (pick ${new URL(site).host} in the browser and here)`);
      // Its output goes to stderr, so stdout stays nanoflow's own (--json).
      if (runInherit("acli", ["jira", "auth", "login", "--web"], { stdio: ["inherit", 2, "inherit"] }) !== 0) throw new Error("acli login did not complete.");
      resetAcliStatus();
      const { client, reason } = await jiraClient(requireRepo().config);
      if (!client || client.via !== "acli") throw new Error(`acli logged in, but nanoflow can't use it for ${site}: ${reason ?? "a JIRA_EMAIL/JIRA_API_TOKEN in the environment wins"}.`);
      const who = await client.myself();
      result({ site, via: "acli", user: who }, () => success(`logged in to ${site} through acli as ${who}`));
    });

  jira
    .command("logout")
    .description("forget the saved API token for the repo's Jira site (acli's own login: acli jira auth logout)")
    .option("--site <url>", "Jira site (default: jira.site in nanoflow.json)")
    .addHelpText("after", "\nExamples:\n  nf jira logout\n  nf jira logout --site https://acme.atlassian.net")
    .action((opts: { site?: string }) => {
      const site = siteOf(opts.site);
      saveJiraCreds(site, null);
      result({ site }, () => success(`forgot the token for ${site}`));
    });

  jira
    .command("whoami")
    .description("check the Jira login: which account, and which way in (acli, or a token and where it comes from)")
    .addHelpText("after", "\nExamples:\n  nf jira whoami\n  nf jira whoami --json")
    .action(async () => {
      const { config } = requireRepo();
      const { client, reason } = await jiraClient(config);
      if (!client) throw new Error(`No Jira access: ${reason}.`);
      const who = await client.myself();
      const from = client.via === "acli" ? "acli" : process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN ? "JIRA_EMAIL + JIRA_API_TOKEN" : credentialsFile();
      result({ site: client.site, via: client.via, user: who, from }, () => {
        success(`${client.site}: ${who}`);
        info(c.dim(`through ${from}`));
      });
    });
};
