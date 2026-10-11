import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { credentialsFile, Jira, jiraClient, jiraCreds, saveJiraCreds, siteKey } from "../lib/jira.mjs";
import { c, info, result, success } from "../lib/output.mjs";
import { ask, secret } from "../lib/prompt.mjs";
import { requireRepo } from "../lib/repo.mjs";

/** The repo's Jira site, or --site. */
const siteOf = (opt: string | undefined): string => {
  if (opt) return siteKey(opt);
  const { config } = requireRepo();
  if (!config.jira.site) throw new Error('No Jira site: set "jira": { "site": "https://acme.atlassian.net" } in .claude/nanoflow.json, or pass --site.');
  return siteKey(config.jira.site);
};

export const registerJira = (program: Command): void => {
  const jira = program.command("jira").description("Jira access for repos with ticket.tracker \"jira\": log in once per site");

  jira
    .command("login")
    .description("save an Atlassian API token for the repo's Jira site (outside the repo), after checking it works")
    .option("--site <url>", "Jira site (default: jira.site in nanoflow.json)")
    .option("--email <email>", "your Atlassian account email")
    .option("--token-stdin", "read the API token from stdin instead of prompting")
    .addHelpText(
      "after",
      [
        "",
        "Create a token at https://id.atlassian.com/manage-profile/security/api-tokens.",
        "Or skip login and export JIRA_EMAIL + JIRA_API_TOKEN (they win over the saved token).",
        "",
        "Examples:",
        "  nf jira login",
        "  nf jira login --email me@acme.com --token-stdin < token.txt",
      ].join("\n"),
    )
    .action(async (opts: { site?: string; email?: string; tokenStdin?: boolean }) => {
      const site = siteOf(opts.site);
      const email = opts.email ?? (await ask(`Atlassian email for ${site}`, "--email"));
      const token = opts.tokenStdin ? readFileSync(0, "utf8").trim() : await secret(`API token (https://id.atlassian.com/manage-profile/security/api-tokens)`, "--token-stdin");
      if (!email || !token) throw new Error("Both an email and an API token are needed.");
      const { config } = requireRepo();
      const who = await new Jira(config, site, { email, token }).myself();
      const file = saveJiraCreds(site, { email, token });
      result({ site, user: who, file }, () => success(`logged in to ${site} as ${who} (saved in ${file})`));
    });

  jira
    .command("logout")
    .description("forget the saved token for the repo's Jira site")
    .option("--site <url>", "Jira site (default: jira.site in nanoflow.json)")
    .addHelpText("after", "\nExamples:\n  nf jira logout\n  nf jira logout --site https://acme.atlassian.net")
    .action((opts: { site?: string }) => {
      const site = siteOf(opts.site);
      saveJiraCreds(site, null);
      result({ site }, () => success(`forgot the token for ${site}`));
    });

  jira
    .command("whoami")
    .description("check the Jira login: which account, and where the token comes from")
    .addHelpText("after", "\nExamples:\n  nf jira whoami\n  nf jira whoami --json")
    .action(async () => {
      const { config } = requireRepo();
      const { client, reason } = jiraClient(config);
      if (!client) throw new Error(`No Jira access: ${reason}.`);
      const who = await client.myself();
      const from = process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN ? "JIRA_EMAIL + JIRA_API_TOKEN" : credentialsFile();
      result({ site: client.site, user: who, from, email: jiraCreds(client.site)?.email }, () => {
        success(`${client.site}: ${who}`);
        info(c.dim(`token from ${from}`));
      });
    });
};
