// The calendar date on the machine's own clock, as YYYY-MM-DD. `toISOString()` gives the UTC
// date instead, which filed anything written 00:00–03:00 in Baghdad under the day before.
const pad = (value: number) => String(value).padStart(2, "0");

export function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// HH:MM on the same clock, for stamps that sit next to a localDate.
export function localTime(now = new Date()): string {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// A stored ISO timestamp read back on the local clock; now when it is empty or invalid.
export function localMoment(iso: string | undefined): Date {
  const parsed = new Date(iso ?? "");
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}
