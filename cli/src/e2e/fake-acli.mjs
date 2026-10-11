#!/usr/bin/env node
// A stand-in for Atlassian's acli in the e2e tests (wired in through NANOFLOW_ACLI). It answers the acli
// commands nanoflow runs by calling the fake Jira (fake-jira.mjs) at FAKE_ACLI_JIRA, the way the real acli
// calls Jira Cloud with the login it keeps. Login state lives in FAKE_ACLI_STATE ({ "loggedIn": true });
// without it, acli is installed but logged out. Every call is appended to FAKE_ACLI_LOG.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const STATE = process.env.FAKE_ACLI_STATE;
const JIRA = process.env.FAKE_ACLI_JIRA;
const AUTH = `Basic ${Buffer.from("e2e@nanoflow.invalid:jira-token").toString("base64")}`;

if (process.env.FAKE_ACLI_LOG) appendFileSync(process.env.FAKE_ACLI_LOG, `${JSON.stringify({ args })}\n`);

const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const loggedIn = () => Boolean(STATE && existsSync(STATE) && JSON.parse(readFileSync(STATE, "utf8")).loggedIn);
const fail = (message) => {
  process.stderr.write(`✗ Error: ${message}\n`);
  process.exitCode = 1;
};
const jira = async (method, route, body) => {
  const res = await fetch(new URL(route, JIRA), {
    method,
    headers: { Authorization: AUTH, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(JSON.parse(text || "{}").errorMessages?.join("; ") || `HTTP ${res.status}`);
  return text ? JSON.parse(text) : {};
};

const main = async () => {
  const cmd = args.filter((a) => !a.startsWith("-")).slice(0, 4).join(" ");
  if (cmd.startsWith("jira auth status")) {
    if (!loggedIn()) return fail("unauthorized: use 'acli jira auth login' to authenticate");
    process.stdout.write(`✓ Authenticated\n  Site: ${new URL(JIRA).host}\n  Email: e2e@nanoflow.invalid\n`);
    return;
  }
  if (cmd.startsWith("jira auth login")) {
    writeFileSync(STATE, JSON.stringify({ loggedIn: true }));
    process.stdout.write("✓ Authentication successful\n");
    return;
  }
  if (!loggedIn()) return fail("unauthorized: use 'acli jira auth login' to authenticate");

  if (cmd.startsWith("jira workitem view")) {
    const key = args[3];
    process.stdout.write(JSON.stringify(await jira("GET", `/rest/api/2/issue/${key}?fields=summary,status`)));
  } else if (cmd.startsWith("jira workitem search")) {
    const res = await jira("GET", `/rest/api/3/search/jql?${new URLSearchParams({ jql: flag("--jql") })}`);
    process.stdout.write(JSON.stringify(res.issues));
  } else if (cmd.startsWith("jira workitem transition")) {
    const key = flag("--key");
    const status = flag("--status");
    const { transitions } = await jira("GET", `/rest/api/2/issue/${key}/transitions`);
    const t = transitions.find((x) => x.to.name.toLowerCase() === status.toLowerCase());
    if (!t) return fail(`no transition to status '${status}' for ${key}`);
    await jira("POST", `/rest/api/2/issue/${key}/transitions`, { transition: { id: t.id } });
    process.stdout.write(`✓ Work item ${key} transitioned to ${status}\n`);
  } else if (cmd.startsWith("jira workitem comment create")) {
    await jira("POST", `/rest/api/2/issue/${flag("--key")}/comment`, { body: flag("--body") });
    process.stdout.write(`✓ Comment added to ${flag("--key")}\n`);
  } else if (cmd.startsWith("jira workitem create")) {
    const created = await jira("POST", "/rest/api/2/issue", {
      fields: { project: { key: flag("--project") }, summary: flag("--summary"), issuetype: { name: flag("--type") }, description: flag("--description") },
    });
    process.stdout.write(JSON.stringify({ key: created.key, self: `${JIRA}/rest/api/3/issue/${created.id}` }));
  } else {
    fail(`unknown command "${cmd}"`);
  }
};

main().catch((err) => fail(err.message));
