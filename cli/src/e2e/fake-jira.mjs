// A stand-in Jira Cloud for the e2e tests: the REST routes nanoflow calls, an in-memory workflow
// (To Do → In Progress → In Review → Done), Basic auth, and a log of every request. Run as its own process
// (the tests block on spawnSync): `node fake-jira.mjs <log-file>` prints the port once it listens.
import { appendFileSync } from "node:fs";
import http from "node:http";

const LOG = process.argv[2];
const AUTH = `Basic ${Buffer.from("e2e@nanoflow.invalid:jira-token").toString("base64")}`;
const STATUSES = { "To Do": "new", "In Progress": "indeterminate", "In Review": "indeterminate", Done: "done" };
const TRANSITIONS = [
  { id: "11", name: "Start progress", to: { name: "In Progress" } },
  { id: "21", name: "Send to review", to: { name: "In Review" } },
  { id: "31", name: "Close", to: { name: "Done" } },
];

const issues = new Map([
  ["ED-15915", { summary: "Stale license warning after reactivation", status: "To Do" }],
  ["ED-15916", { summary: "Already closed", status: "Done" }],
]);
let next = 16000;

const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};
const issueJson = (key) => {
  const i = issues.get(key);
  return { key, fields: { summary: i.summary, status: { name: i.status, statusCategory: { key: STATUSES[i.status] } } } };
};

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const url = new URL(req.url, "http://localhost");
      const body = raw ? JSON.parse(raw) : undefined;
      if (LOG) appendFileSync(LOG, `${JSON.stringify({ method: req.method, path: url.pathname, query: url.search, body })}\n`);
      if (req.headers.authorization !== AUTH) return json(res, 401, { errorMessages: ["Client must be authenticated"] });

      const p = url.pathname;
      if (p === "/rest/api/2/myself") return json(res, 200, { displayName: "E2E User", emailAddress: "e2e@nanoflow.invalid" });
      if (p === "/rest/api/3/search/jql") {
        const keys = /key in \(([^)]*)\)/.exec(url.searchParams.get("jql") ?? "")?.[1].split(",") ?? [];
        return json(res, 200, { issues: keys.filter((k) => issues.has(k)).map(issueJson) });
      }
      if (p === "/rest/api/2/issue" && req.method === "POST") {
        const key = `${body.fields.project.key}-${next++}`;
        issues.set(key, { summary: body.fields.summary, status: "To Do" });
        return json(res, 201, { id: "1", key });
      }
      const m = /^\/rest\/api\/2\/issue\/([^/]+)(\/transitions|\/comment)?$/.exec(p);
      const key = m && decodeURIComponent(m[1]);
      if (!key || !issues.has(key)) return json(res, 404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
      if (!m[2]) return json(res, 200, issueJson(key));
      if (m[2] === "/comment") return json(res, 201, { id: "c1" });
      if (req.method === "GET") return json(res, 200, { transitions: TRANSITIONS });
      const t = TRANSITIONS.find((x) => x.id === body.transition.id);
      if (!t) return json(res, 400, { errorMessages: ["Transition is not valid"] });
      issues.get(key).status = t.to.name;
      return json(res, 204);
    });
  })
  .listen(0, "127.0.0.1", function () {
    process.stdout.write(`${this.address().port}\n`);
  });
