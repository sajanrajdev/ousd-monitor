export const counts = new Map<string, { pass: number; fail: number }>();

export const undeterminedContrast: string[] = [];

export const failures: string[] = [];

export const notRun = new Set<string>();

export function check(name: string, where: string, ok: unknown, detail = "") {
  const count = counts.get(name) ?? { pass: 0, fail: 0 };
  count[ok ? "pass" : "fail"] += 1;
  counts.set(name, count);
  if (!ok) failures.push(`${where}: ${name}${detail ? ` (${detail})` : ""}`);
}

// A step that can't finish is a failure of that step, and the other checks still run and report.
export async function guarded(name: string, where: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    check(`${name} ran to the end`, where, false, (error as Error).message.split("\n")[0]);
  }
}

// How many folders held real data, which the fold check needs.
export const seen = { realFolders: 0 };
