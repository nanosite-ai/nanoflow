import type { Command } from "commander";
import { ACLI_INSTALL, acliStatus, jiraClient, resetAcliStatus, siteKey } from "../lib/jira.mjs";
import { info, result, success } from "../lib/output.mjs";
import { runInherit } from "../lib/proc.mjs";
import { requireRepo } from "../lib/repo.mjs";

/** acli asks which site in the terminal: an agent's shell can't answer that. */
const LOGIN_NEEDS_TTY =
  "acli login did not complete. It asks you to pick the site in the terminal, which an agent's shell can't answer: run `nf jira login` (or `acli jira auth login --web`) in your own terminal.";

export const registerJira = (program: Command): void => {
  const jira = program.command("jira").description('Jira access for repos with ticket.tracker "jira", through acli (Atlassian\'s CLI, like gh for GitHub)');

  jira
    .command("login")
    .description("log in to the repo's Jira through acli's browser login (acli keeps the login); run it in your own terminal")
    .addHelpText("after", ["", `Install acli first: ${ACLI_INSTALL}`, "", "Examples:", "  nf jira login"].join("\n"))
    .action(async () => {
      const { config } = requireRepo();
      if (!config.jira.site) throw new Error('No Jira site: set "jira": { "site": "https://acme.atlassian.net" } in .claude/nanoflow.json.');
      const site = siteKey(config.jira.site);
      if (!(await acliStatus()).installed) throw new Error(`acli is not installed: ${ACLI_INSTALL}`);
      info(`acli jira auth login --web  (pick ${new URL(site).host} in the browser and here)`);
      // acli's output goes to stderr, so stdout stays nanoflow's own (--json).
      if (runInherit("acli", ["jira", "auth", "login", "--web"], { stdio: ["inherit", 2, "inherit"] }) !== 0) throw new Error(LOGIN_NEEDS_TTY);
      resetAcliStatus();
      const { client, reason } = await jiraClient(config);
      if (!client) throw new Error(`acli logged in, but nanoflow can't use it: ${reason}.`);
      const who = await client.myself();
      result({ site, user: who }, () => success(`logged in to ${site} through acli as ${who}`));
    });

  jira
    .command("whoami")
    .description("check the Jira login: the site and the account acli is signed in with")
    .addHelpText("after", "\nExamples:\n  nf jira whoami\n  nf jira whoami --json")
    .action(async () => {
      const { client, reason } = await jiraClient(requireRepo().config);
      if (!client) throw new Error(`No Jira access: ${reason}.`);
      const who = await client.myself();
      result({ site: client.site, user: who }, () => success(`${client.site}: ${who} (through acli)`));
    });
};
