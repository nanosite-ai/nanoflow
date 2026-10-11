// Prompts that never block an agent: without a TTY (or with --yes / --json) nanoflow never prompts.
// --yes answers confirms; anything else fails fast, naming the flag that answers it.
import { confirm as inqConfirm } from "@inquirer/prompts";
import { isJsonMode } from "./output.mjs";

let assumeYes = false;
export const setAssumeYes = (on: boolean): void => {
  assumeYes = on;
};

export class NeedsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeedsInputError";
  }
}

const canPrompt = (): boolean => Boolean(process.stdin.isTTY) && !isJsonMode();

/** Ask yes/no. Non-interactive: true only with --yes, otherwise throws naming --yes. */
export const confirm = async (message: string): Promise<boolean> => {
  if (assumeYes) return true;
  if (!canPrompt()) throw new NeedsInputError(`needs confirmation (${message}): re-run with --yes`);
  return inqConfirm({ message, default: false });
};
