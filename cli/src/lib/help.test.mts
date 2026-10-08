// Every command teaches by example, and docs/cli.md is the help text, regenerated.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { helpOf, leafCommands, renderDocs } from "../commands/setup.mjs";
import { buildProgram } from "../registry.mjs";

const DOC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "cli.md");
const leaves = leafCommands(buildProgram()).filter((cmd) => cmd.name() !== "help");

describe("--help", () => {
  test.each(leaves.map((cmd) => [cmd.parent?.name() === "nanoflow" ? cmd.name() : `${cmd.parent?.name()} ${cmd.name()}`, cmd] as const))(
    "%s has a description and examples",
    (_name, cmd) => {
      expect(cmd.description().length).toBeGreaterThan(10);
      expect(helpOf(cmd)).toMatch(/\nExamples:\n {2}(nf|nanoflow) /);
    },
  );

  test("docs/cli.md is current (nanoflow docs --write)", () => {
    expect(readFileSync(DOC, "utf8").replace(/\r\n/g, "\n")).toBe(renderDocs(buildProgram()));
  });
});
