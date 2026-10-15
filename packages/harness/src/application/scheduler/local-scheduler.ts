import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { AgentRuntimeDeps } from "@ocean/core/domain/ports/runtime-ports.js";
import { oceanPath, SYSTEM_DIR } from "../../paths.js";
import { runAgent } from "../runs/run-agent.js";

export type Schedule = {
  id: string;
  profile: string;
  prompt: string;
  intervalMs: number;
  nextRunAt: string;
  enabled: boolean;
  attempts?: number;
  retryAt?: string;
};
const file = () => oceanPath(SYSTEM_DIR, "schedules.json");
const running = new Set<string>();

export async function listSchedules(): Promise<Schedule[]> {
  try {
    return JSON.parse(await readFile(file(), "utf8")) as Schedule[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function saveSchedule(schedule: Schedule): Promise<void> {
  if (!Number.isFinite(schedule.intervalMs) || schedule.intervalMs < 1_000)
    throw new Error("Schedule interval must be at least 1000ms");
  await mutateSchedules((schedules) => [
    ...schedules.filter((item) => item.id !== schedule.id),
    schedule,
  ]);
}

export async function setScheduleEnabled(
  id: string,
  enabled: boolean,
): Promise<Schedule> {
  let updated: Schedule | undefined;
  await mutateSchedules((schedules) =>
    schedules.map((schedule) => {
      if (schedule.id !== id) return schedule;
      updated = { ...schedule, enabled };
      return updated;
    }),
  );
  if (!updated) throw new Error(`Schedule not found: ${id}`);
  return updated;
}

export async function runSchedule(
  id: string,
  cwd: string,
  runtime: AgentRuntimeDeps,
): Promise<void> {
  const schedule = (await listSchedules()).find((item) => item.id === id);
  if (!schedule) throw new Error(`Schedule not found: ${id}`);
  await runAgent(
    { profileName: schedule.profile, prompt: schedule.prompt, cwd },
    runtime,
  );
}

export async function runDueSchedules(
  cwd: string,
  runtime: AgentRuntimeDeps,
): Promise<string[]> {
  const now = Date.now();
  const schedules = await listSchedules();
  const ran: string[] = [];
  for (const schedule of schedules) {
    if (
      !schedule.enabled ||
      Date.parse(schedule.nextRunAt) > now ||
      (schedule.retryAt && Date.parse(schedule.retryAt) > now) ||
      running.has(schedule.id)
    )
      continue;
    const lease = await acquireLease(schedule.id);
    if (!lease) continue;
    running.add(schedule.id);
    try {
      const session = await runAgent(
        { profileName: schedule.profile, prompt: schedule.prompt, cwd },
        runtime,
      );
      if (session.status !== "completed")
        throw new Error(`Scheduled run failed: ${session.sessionId}`);
      schedule.nextRunAt = new Date(now + schedule.intervalMs).toISOString();
      ran.push(schedule.id);
    } finally {
      running.delete(schedule.id);
      await lease.close();
      await unlink(leaseFile(schedule.id)).catch(() => undefined);
    }
  }
  for (const id of ran) {
    const completed = schedules.find((schedule) => schedule.id === id);
    if (completed)
      await mutateSchedules((current) =>
        current.map((item) =>
          item.id === id ? { ...item, nextRunAt: completed.nextRunAt } : item,
        ),
      );
  }
  return ran;
}

export async function runSchedulerWorkerOnce(
  cwd: string,
  runtime: AgentRuntimeDeps,
): Promise<string[]> {
  const schedules = await listSchedules();
  const ran: string[] = [];
  for (const schedule of schedules) {
    if (!schedule.enabled || Date.parse(schedule.nextRunAt) > Date.now())
      continue;
    const lease = leaseFile(schedule.id);
    const handle = await acquireLease(schedule.id);
    if (!handle) continue;
    try {
      try {
        const session = await runAgent(
          { profileName: schedule.profile, prompt: schedule.prompt, cwd },
          runtime,
        );
        if (session.status !== "completed")
          throw new Error(`Scheduled run failed: ${session.sessionId}`);
        schedule.nextRunAt = new Date(
          Date.now() + schedule.intervalMs,
        ).toISOString();
        schedule.attempts = 0;
        delete schedule.retryAt;
        ran.push(schedule.id);
      } catch {
        schedule.attempts = (schedule.attempts ?? 0) + 1;
        const delay = Math.min(
          schedule.intervalMs * 2 ** Math.min(schedule.attempts, 5),
          3_600_000,
        );
        schedule.retryAt = new Date(Date.now() + delay).toISOString();
        schedule.nextRunAt = schedule.retryAt;
      }
    } finally {
      await handle.close();
      await unlink(lease).catch(() => undefined);
    }
  }
  for (const changed of schedules) {
    if (
      !ran.includes(changed.id) &&
      changed.attempts === undefined &&
      changed.retryAt === undefined
    )
      continue;
    await mutateSchedules((current) =>
      current.map((item) => {
        if (item.id !== changed.id) return item;
        const updated = {
          ...item,
          nextRunAt: changed.nextRunAt,
          attempts: changed.attempts,
        };
        if (changed.retryAt) updated.retryAt = changed.retryAt;
        else delete updated.retryAt;
        return updated;
      }),
    );
  }
  return ran;
}

export async function runSchedulerWorker(
  cwd: string,
  runtime: AgentRuntimeDeps,
  options: {
    pollMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const pollMs = Math.max(1_000, options.pollMs ?? 30_000);
  while (!options.signal?.aborted) {
    await runSchedulerWorkerOnce(cwd, runtime);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

function leaseFile(id: string): string {
  return oceanPath(SYSTEM_DIR, "schedules", `${id}.lease`);
}

async function acquireLease(
  id: string,
): Promise<Awaited<ReturnType<typeof open>> | null> {
  const lease = leaseFile(id);
  await mkdir(path.dirname(lease), { recursive: true });
  try {
    const handle = await open(lease, "wx");
    await handle.writeFile(`${process.pid}\n`);
    return handle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const leaseContents = (
        await readFile(lease, "utf8").catch(() => "")
      ).trim();
      if (!leaseContents) return null;
      const owner = Number.parseInt(leaseContents, 10);
      if (Number.isInteger(owner) && owner > 0 && processIsAlive(owner))
        return null;
      await unlink(lease).catch(() => undefined);
      try {
        const handle = await open(lease, "wx");
        await handle.writeFile(`${process.pid}\n`);
        return handle;
      } catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code === "EEXIST")
          return null;
        throw retryError;
      }
    }
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function mutateSchedules(
  update: (schedules: Schedule[]) => Schedule[],
): Promise<void> {
  let lease: Awaited<ReturnType<typeof open>> | null = null;
  for (let attempt = 0; attempt < 100 && !lease; attempt += 1) {
    lease = await acquireLease("__registry__");
    if (!lease) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!lease) throw new Error("Schedule registry remained busy for 1 second");
  try {
    const schedules = update(await listSchedules());
    await mkdir(path.dirname(file()), { recursive: true });
    const temporary = `${file()}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(schedules, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, file());
  } finally {
    await lease.close();
    await unlink(leaseFile("__registry__")).catch(() => undefined);
  }
}
