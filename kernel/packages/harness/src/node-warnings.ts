// Node prints "ExperimentalWarning: SQLite is an experimental feature" on every run that loads
// node:sqlite, which the session store and brain index always do. Drop that one warning and
// pass every other through. main.ts imports this before it loads anything that reaches
// node:sqlite; a static import chain would load the builtin before this filter is installed.
const emitWarning = process.emitWarning;

process.emitWarning = function (
  this: NodeJS.Process,
  warning: string | Error,
  ...rest: unknown[]
): void {
  const options = rest[0];
  const type =
    typeof options === "string"
      ? options
      : (options as { type?: unknown } | undefined)?.type;
  const message = typeof warning === "string" ? warning : warning.message;
  if (type === "ExperimentalWarning" && message.startsWith("SQLite")) return;
  (emitWarning as (...args: unknown[]) => void).call(this, warning, ...rest);
} as typeof process.emitWarning;
