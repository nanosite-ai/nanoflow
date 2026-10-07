// PR screenshots live on one orphan branch (default `assets/pr-screenshots`), one `pr-<n>-<slug>/` folder per
// PR, so binaries never enter the merge diff and still render inline in the PR, even on a private repo.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gh, repoSlug } from "./gh.mjs";
import { tempFile } from "./globals.mjs";
import { tryRun } from "./proc.mjs";
import type { RepoContext } from "./repo.mjs";

export const SCREENSHOTS_HEADING = "## Screenshots";

/** `pr-652-csv-export` for branch feat/651-csv-export and PR 652. */
export const shotsFolder = (pr: number, branch: string): string => {
  const slug = branch.replace(/^.*?\/?\d+-/, "").replace(/[^a-z0-9-]/gi, "-").toLowerCase() || "shots";
  return `pr-${pr}-${slug}`;
};

export const shotRepoPath = (folder: string, file: string): string => `${folder}/${path.basename(file).replace(/[^\w.-]+/g, "-")}`;

/** A URL that renders inline for collaborators, private repos included. */
export const shotRawUrl = (slug: string, branch: string, repoPath: string): string => {
  const url = new URL("https://github.com");
  url.pathname = [...slug.split("/"), "raw", ...branch.split("/"), ...repoPath.split("/")].map(encodeURIComponent).join("/");
  return url.href;
};

export const shotMarkdown = (slug: string, branch: string, repoPath: string): string => {
  const alt = path.basename(repoPath).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
  return `![${alt}](${shotRawUrl(slug, branch, repoPath)})`;
};

/** Put the images under the body's `## Screenshots` section (replacing a placeholder comment), or append one. */
export const attachShotsToBody = (body: string, markdown: string[]): string => {
  const block = markdown.join("\n\n");
  const normalized = body.replace(/\r\n/g, "\n");
  const idx = normalized.search(/^## Screenshots[ \t]*$/m);
  if (idx === -1) return `${normalized.trimEnd()}\n\n${SCREENSHOTS_HEADING}\n\n${block}\n`;
  const afterHeading = idx + SCREENSHOTS_HEADING.length;
  const nextSection = normalized.indexOf("\n## ", afterHeading);
  const end = nextSection === -1 ? normalized.length : nextSection;
  const existing = normalized.slice(afterHeading, end).replace(/<!--[\s\S]*?-->/g, "").trim();
  const section = `${SCREENSHOTS_HEADING}\n\n${existing ? `${existing}\n\n` : ""}${block}\n`;
  return `${normalized.slice(0, idx)}${section}${nextSection === -1 ? "" : normalized.slice(end)}`;
};

export interface UploadedShot {
  file: string;
  repoPath: string;
  markdown: string;
}

const contentsEndpoint = (slug: string, repoPath: string): string => `repos/${slug}/contents/${repoPath.split("/").map(encodeURIComponent).join("/")}`;

/** Create the orphan screenshots branch (one empty commit, pushed through the API) when it is missing. */
const ensureShotsBranch = (slug: string, branch: string): void => {
  if (tryRun("gh", ["api", `repos/${slug}/branches/${encodeURIComponent(branch)}`, "--jq", ".name"])) return;
  const tree = gh(["api", "-X", "POST", `repos/${slug}/git/trees`, "--input", tempFile("tree.json", JSON.stringify({ tree: [{ path: "README.md", mode: "100644", type: "blob", content: "PR screenshots, one folder per PR. Never merged.\n" }] })), "--jq", ".sha"]);
  const commit = gh(["api", "-X", "POST", `repos/${slug}/git/commits`, "-f", "message=chore: screenshots branch", "-f", `tree=${tree}`, "--jq", ".sha"]);
  gh(["api", "-X", "POST", `repos/${slug}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${commit}`]);
};

/**
 * PUT each file through the contents API. The JSON goes through `--input <tmpfile>` (inline base64 hits
 * "Argument list too long"); an existing file's sha is passed so re-uploads overwrite.
 */
export const uploadShots = (repo: RepoContext, args: { pr: number; branch: string; files: string[] }): UploadedShot[] => {
  const slug = repoSlug(repo);
  const shotsBranch = repo.config.pr.shotsBranch;
  ensureShotsBranch(slug, shotsBranch);
  const folder = shotsFolder(args.pr, args.branch);
  return args.files.map((file) => {
    if (!existsSync(file)) throw new Error(`No such file: ${file}`);
    const repoPath = shotRepoPath(folder, file);
    const sha = tryRun("gh", ["api", `${contentsEndpoint(slug, repoPath)}?ref=${encodeURIComponent(shotsBranch)}`, "--jq", ".sha"]);
    const payload = { message: `chore: screenshots for PR #${args.pr}`, branch: shotsBranch, content: readFileSync(file).toString("base64"), ...(sha ? { sha } : {}) };
    gh(["api", "-X", "PUT", contentsEndpoint(slug, repoPath), "--input", tempFile("put.json", JSON.stringify(payload)), "--jq", ".content.path"]);
    return { file, repoPath, markdown: shotMarkdown(slug, shotsBranch, repoPath) };
  });
};
