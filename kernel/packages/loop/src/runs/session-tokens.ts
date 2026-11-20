// A provider's final `result` line (Claude's stream-json) carries the session's usage; the sum
// of input, cache and output tokens, or null when no event reports any.
export function sessionTokens(
  events: Array<{ type: string; data: string }>,
): number | null {
  let total: number | null = null;
  for (const event of events) {
    if (event.type !== "json" || !event.data.includes('"usage"')) continue;
    let parsed: { type?: string; usage?: Record<string, unknown> };
    try {
      parsed = JSON.parse(event.data);
    } catch {
      continue;
    }
    if (parsed.type !== "result" || !parsed.usage) continue;
    const usage = parsed.usage;
    const sum = [
      "input_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
      "output_tokens",
    ].reduce((acc, key) => acc + (Number(usage[key]) || 0), 0);
    // A zero-usage result (a synthetic or refused turn) is not a report.
    if (sum > 0) total = (total ?? 0) + sum;
  }
  return total;
}
