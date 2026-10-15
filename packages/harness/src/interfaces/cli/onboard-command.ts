import { createInterface } from "node:readline/promises";
import {
  loadOnboardingState,
  type OnboardingState,
  saveOnboardingState,
} from "../../application/onboarding/state.js";
import {
  buildSteps,
  ONBOARDING_VERSION,
  type OnboardingIO,
  type OnboardingStep,
} from "../../application/onboarding/steps.js";
import { setup } from "./setup-command.js";

export type OnboardOptions = {
  yes?: boolean;
  reset?: string;
  io?: OnboardingIO;
  steps?: OnboardingStep[];
};

function terminalIO(interactive: boolean): {
  io: OnboardingIO;
  close(): void;
} {
  const prompt = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  return {
    io: {
      interactive,
      say: (line) => console.log(line),
      ask: async (question, fallback) =>
        prompt ? await prompt.question(question) : fallback,
    },
    close: () => prompt?.close(),
  };
}

// Runs every step that is not already done/skipped, saving after each one so an
// interrupted run resumes at the first pending step. A completed state is a no-op.
export async function onboard(options: OnboardOptions = {}): Promise<void> {
  const interactive =
    !options.yes && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const terminal = options.io ? undefined : terminalIO(interactive);
  const io = options.io ?? (terminal as { io: OnboardingIO }).io;
  const steps = options.steps ?? buildSteps({ setup: () => setup() });
  try {
    const state: OnboardingState = await loadOnboardingState();
    if (options.reset) {
      if (!steps.some((step) => step.id === options.reset))
        throw new Error(`Unknown onboarding step '${options.reset}'`);
      delete state.steps[options.reset];
    }
    const pending = steps.filter((step) => !state.steps[step.id]);
    if (pending.length === 0) {
      io.say(
        "Ocean onboarding is complete. Use `ocean onboard --reset <step>` to redo a step, or `ocean doctor` for health.",
      );
      return;
    }
    io.say(
      `Ocean onboarding: ${pending.length} of ${steps.length} steps to go.`,
    );
    for (const [index, step] of pending.entries()) {
      io.say(`\n[${index + 1}/${pending.length}] ${step.title}`);
      state.steps[step.id] =
        !io.interactive && step.optional ? "skipped" : await step.run(io);
      state.version = ONBOARDING_VERSION;
      await saveOnboardingState(state);
    }
    await onboardStatus(steps, io.say);
    const skipped = Object.entries(state.steps)
      .filter(([, status]) => status === "skipped")
      .map(([id]) => id);
    io.say(
      `\nOnboarding finished.${skipped.length ? ` Skipped: ${skipped.join(", ")} (redo with ocean onboard --reset <step>).` : ""}`,
    );
  } finally {
    terminal?.close();
  }
}

// Read-only: shows each step as done, skipped or pending, without running anything.
export async function onboardStatus(
  steps: OnboardingStep[],
  say: (line: string) => void = console.log,
): Promise<void> {
  const state = await loadOnboardingState();
  for (const step of steps)
    say(
      `${(state.steps[step.id] ?? "pending").padEnd(8)} ${step.id.padEnd(10)} ${step.title}`,
    );
}

// Re-runs just the clients step (enable/disable + sync), independent of onboarding state.
export async function manageClients(): Promise<void> {
  const step = buildSteps({ setup: () => setup() }).find(
    (candidate) => candidate.id === "clients",
  );
  const terminal = terminalIO(
    Boolean(process.stdin.isTTY && process.stdout.isTTY),
  );
  try {
    await step?.run(terminal.io);
  } finally {
    terminal.close();
  }
}

export async function runOnboardCommand(argv: string[]): Promise<void> {
  if (argv.includes("--status")) {
    await onboardStatus(buildSteps({ setup: () => setup() }));
    return;
  }
  const resetIndex = argv.indexOf("--reset");
  const reset = resetIndex >= 0 ? argv[resetIndex + 1] : undefined;
  if (resetIndex >= 0 && !reset) {
    console.error("Usage: ocean onboard [--yes] [--status] [--reset <step>]");
    process.exitCode = 1;
    return;
  }
  await onboard({ yes: argv.includes("--yes"), reset });
}
