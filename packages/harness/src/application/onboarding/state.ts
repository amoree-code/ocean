import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { oceanPath, SYSTEM_DIR } from "../../paths.js";

type StepStatus = "done" | "skipped";

export type OnboardingState = {
  version: number;
  steps: Record<string, StepStatus>;
};

export function onboardingStatePath(): string {
  return oceanPath(SYSTEM_DIR, "state", "onboarding.json");
}

export async function loadOnboardingState(): Promise<OnboardingState> {
  try {
    const parsed = JSON.parse(
      await readFile(onboardingStatePath(), "utf8"),
    ) as Partial<OnboardingState>;
    return { version: parsed.version ?? 0, steps: parsed.steps ?? {} };
  } catch {
    return { version: 0, steps: {} };
  }
}

export async function saveOnboardingState(
  state: OnboardingState,
): Promise<void> {
  const file = onboardingStatePath();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporary, file);
}
