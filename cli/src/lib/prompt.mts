// Prompts that never block an agent: without a TTY (or with --yes / --json) nanoflow never prompts.
// --yes answers confirms; anything else fails fast, naming the flag that answers it.
import { confirm as inqConfirm, input as inqInput, password as inqPassword } from "@inquirer/prompts";
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

/** Ask for a secret, masked. Non-interactive: throws naming the flag that supplies it. */
export const secret = async (message: string, flag: string): Promise<string> => {
  if (!canPrompt()) throw new NeedsInputError(`needs ${message}: pass it with ${flag}`);
  return inqPassword({ message, mask: "*" });
};

/** Ask for a line of text. Non-interactive: throws naming the flag that supplies it. */
export const ask = async (message: string, flag: string): Promise<string> => {
  if (!canPrompt()) throw new NeedsInputError(`needs ${message}: pass ${flag}`);
  return inqInput({ message });
};

/** Ask yes/no. Non-interactive: true only with --yes, otherwise throws naming --yes. */
export const confirm = async (message: string): Promise<boolean> => {
  if (assumeYes) return true;
  if (!canPrompt()) throw new NeedsInputError(`needs confirmation (${message}): re-run with --yes`);
  return inqConfirm({ message, default: false });
};
