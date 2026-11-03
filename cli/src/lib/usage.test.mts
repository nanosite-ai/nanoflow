import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { collectUsage, formatTokens, parseTranscript, projectSlug, titleNamesBranch } from "./usage.mjs";

const reply = (id: string, model: string, u: Partial<Record<"input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens", number>>, ts = "2026-11-01T10:00:00Z"): string =>
  JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model, role: "assistant", content: [], usage: { input_tokens: 0, output_tokens: 0, ...u } } });

const title = (t: string): string => JSON.stringify({ type: "custom-title", customTitle: t, sessionId: "s" });

describe("usage: one transcript", () => {
  test("counts each response once, by model, and skips the engine's free notes", () => {
    const text = [
      JSON.stringify({ type: "user", timestamp: "2026-11-01T09:59:00Z", message: { role: "user", content: "hi" } }),
      // One response is written once per content block, each copy with the same usage.
      reply("m1", "claude-opus-5-5", { input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }),
      reply("m1", "claude-opus-5-5", { input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }),
      reply("m2", "claude-opus-5-5", { input_tokens: 3, output_tokens: 10, cache_read_input_tokens: 2000 }),
      reply("m3", "claude-haiku-5-5", { input_tokens: 400, output_tokens: 20 }),
      reply("m4", "<synthetic>", {}),
      "not json {",
      title("#7 · feat/7-x · x"),
    ].join("\n");
    const got = parseTranscript(text);
    expect(got.models).toEqual({
      "claude-opus-5-5": { input: 5, output: 110, cacheRead: 3000, cacheWrite: 50, requests: 2 },
      "claude-haiku-5-5": { input: 400, output: 20, cacheRead: 0, cacheWrite: 0, requests: 1 },
    });
    expect(got.title).toBe("#7 · feat/7-x · x");
    expect(got.startedAt).toBe("2026-11-01T09:59:00Z");
  });

  test("a title names a branch as a whole word", () => {
    expect(titleNamesBranch("#83 · feat/83-x · x", "feat/83-x")).toBe(true);
    expect(titleNamesBranch("#830 · feat/830-x-y · x", "feat/83-x")).toBe(false);
    expect(titleNamesBranch(null, "feat/83-x")).toBe(false);
  });

  test("short counts for a dashboard", () => {
    expect([950, 1234, 45_600, 1_234_567, 37_800_000].map(formatTokens)).toEqual(["950", "1.2k", "46k", "1.23M", "37.8M"]);
  });
});

describe("usage: sessions per worktree", () => {
  test("a worktree counts its own sessions, the main checkout's titled with its branch, and their subagents; main keeps the rest", () => {
    const base = mkdtempSync(path.join(tmpdir(), "nf-usage-"));
    const projects = path.join(base, "projects");
    const mainPath = path.join(base, "repo");
    const wtPath = path.join(base, "repo-7-x");
    mkdirSync(mainPath);
    mkdirSync(wtPath);
    const mainDir = path.join(projects, projectSlug(mainPath));
    const wtDir = path.join(projects, projectSlug(wtPath));
    mkdirSync(path.join(mainDir, "a-titled", "subagents"), { recursive: true });
    mkdirSync(wtDir, { recursive: true });
    const now = Date.now();
    const write = (file: string, lines: string[]): void => {
      writeFileSync(file, lines.join("\n"));
      utimesSync(file, new Date(now), new Date(now));
    };
    write(path.join(mainDir, "a-titled.jsonl"), [reply("a1", "claude-opus-5-5", { output_tokens: 10 }), title("#7 · feat/7-x · x")]);
    write(path.join(mainDir, "a-titled", "subagents", "agent-1.jsonl"), [reply("sub1", "claude-haiku-5-5", { input_tokens: 7 })]);
    write(path.join(mainDir, "b-main.jsonl"), [reply("b1", "claude-opus-5-5", { output_tokens: 1 })]);
    write(path.join(wtDir, "c-own.jsonl"), [reply("c1", "claude-opus-5-5", { output_tokens: 100 })]);
    write(path.join(mainDir, "d-empty.jsonl"), [title("nothing spent")]);

    const snap = collectUsage(
      [
        { name: "repo", path: mainPath, branch: "main", isMain: true },
        { name: "repo-7-x", path: wtPath, branch: "feat/7-x", isMain: false },
      ],
      { days: 7, now: now + 1000, projects },
    );
    const [main, wt] = snap.worktrees;
    expect(main?.sessions.map((s) => s.id)).toEqual(["b-main"]);
    expect(wt?.sessions.map((s) => s.id).sort()).toEqual(["a-titled", "c-own"]);
    const titled = wt?.sessions.find((s) => s.id === "a-titled");
    expect(Object.keys(titled?.models ?? {}).sort()).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
    expect(wt?.total).toEqual({ input: 7, output: 110, cacheRead: 0, cacheWrite: 0, requests: 3 });
    expect(snap.total.output).toBe(111);
    expect(snap.models["claude-haiku-5-5"]?.input).toBe(7);
  });
});
