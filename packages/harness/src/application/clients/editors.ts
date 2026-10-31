// Format-preserving edits of one MCP server table inside a client's own config (T-296 P2).
// An editor reads the servers it can understand and applies set / rename / remove of whole
// server entries; every other byte of the file is left as it was. When a file cannot be edited
// that way (unparseable, non-canonical JSON, a YAML list), the editor says so and nothing is
// written: the change becomes a manual step instead of a rewrite.

// The keys an Ocean-managed entry may carry. An entry with any other key (env, headers…) is the
// user's and is never rewritten.
export const ENTRY_KEYS = ["command", "args", "cwd", "type", "enabled"];

export type ServerValue = Record<string, unknown>;

export type Op =
  | { kind: "set"; key: string; value: ServerValue }
  | { kind: "rename"; key: string; to: string }
  | { kind: "remove"; key: string };

export class ManualEdit extends Error {}

export type Editor = {
  // null: this file cannot be read as a server table.
  servers(text: string): Map<string, ServerValue> | null;
  apply(text: string, ops: Op[]): string;
};

// --- JSON: parse and re-serialize, only when the file is already in that exact form ----------

export function jsonEditor(
  tablePath: string[],
  toNative: (value: ServerValue) => unknown = (value) => value,
  fromNative: (node: unknown) => ServerValue = (node) => node as ServerValue,
): Editor {
  const parse = (text: string) => {
    const source = text.trim() ? text : "{}\n";
    const parsed = JSON.parse(source) as Record<string, unknown>;
    const indent = /\n(\t| +)"/.exec(source)?.[1] ?? "  ";
    const trailing = source.endsWith("\n");
    const render = (value: unknown) =>
      `${JSON.stringify(value, null, indent)}${trailing ? "\n" : ""}`;
    if (render(parsed) !== source)
      throw new ManualEdit(
        "the file is not in canonical JSON form; rewriting it would change unrelated bytes",
      );
    return { parsed, render };
  };
  const table = (root: Record<string, unknown>, create: boolean) => {
    let node: Record<string, unknown> = root;
    for (const key of tablePath) {
      if (node[key] === undefined && create) node[key] = {};
      const next = node[key];
      if (!next || typeof next !== "object" || Array.isArray(next)) return null;
      node = next as Record<string, unknown>;
    }
    return node;
  };
  return {
    servers(text) {
      try {
        const source = text.trim() ? text : "{}";
        const found = table(JSON.parse(source), false);
        return new Map(
          Object.entries(found ?? {}).map(([key, node]) => [
            key,
            fromNative(node),
          ]),
        );
      } catch {
        return null;
      }
    },
    apply(text, ops) {
      const { parsed, render } = parse(text);
      const servers = table(parsed, true);
      if (!servers) throw new ManualEdit("the server table is not an object");
      for (const op of ops) {
        if (op.kind === "set") servers[op.key] = toNative(op.value);
        else if (op.kind === "remove") delete servers[op.key];
        else {
          // In place, so a rename and its undo leave the key order as it was.
          const entries = Object.entries(servers);
          for (const [key] of entries) delete servers[key];
          for (const [key, value] of entries)
            servers[key === op.key ? op.to : key] = value;
        }
      }
      return render(parsed);
    },
  };
}

// --- shared scalar handling for TOML / YAML ---------------------------------------------------

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value === "true" || value === "false") return value === "true";
  if (value.startsWith("["))
    return JSON.parse(value.replace(/'([^']*)'/g, '"$1"'));
  return value;
}

const quote = (value: unknown) => JSON.stringify(value);

// --- TOML: one `[<table>.<key>]` section per server -------------------------------------------

export function tomlEditor(table: string): Editor {
  const header = /^\s*\[([^\]]+)\]\s*$/;
  type Section = { name: string; start: number; end: number };
  const sections = (lines: string[]): Section[] => {
    const found: Section[] = [];
    lines.forEach((line, index) => {
      const match = header.exec(line);
      if (!match) return;
      if (found.length) found[found.length - 1].end = index;
      found.push({ name: match[1].trim(), start: index, end: lines.length });
    });
    return found;
  };
  const prefix = `${table}.`;
  const serverKey = (name: string) =>
    name.startsWith(prefix) &&
    /^[A-Za-z0-9_-]+$/.test(name.slice(prefix.length))
      ? name.slice(prefix.length)
      : null;
  const render = (key: string, value: ServerValue) => [
    `[${prefix}${key}]`,
    ...ENTRY_KEYS.filter((field) => value[field] !== undefined).map(
      (field) =>
        `${field} = ${
          Array.isArray(value[field])
            ? `[${(value[field] as unknown[]).map(quote).join(", ")}]`
            : quote(value[field])
        }`,
    ),
  ];
  const read = (lines: string[], section: Section): ServerValue => {
    const value: ServerValue = {};
    const body = lines.slice(section.start + 1, section.end).join("\n");
    // Multi-line arrays are joined first, then each `key = value` is read.
    const statements = body
      .replace(/\[\s*\n([\s\S]*?)\]/g, (match) =>
        match.replace(/\s*\n\s*/g, " "),
      )
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    for (const statement of statements) {
      const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(statement);
      if (!match) throw new ManualEdit(`cannot read '${statement}'`);
      value[match[1]] = parseScalar(match[2].replace(/,\s*\]$/, "]"));
    }
    return value;
  };
  return {
    servers(text) {
      try {
        const lines = text.split("\n");
        const all = sections(lines);
        const result = new Map<string, ServerValue>();
        for (const section of all) {
          const key = serverKey(section.name);
          if (!key) continue;
          const value = read(lines, section);
          // A sub-table (`[mcp_servers.x.env]`) belongs to the entry: mark it as not ours.
          if (all.some((other) => other.name.startsWith(`${section.name}.`)))
            value.__subtables = true;
          result.set(key, value);
        }
        return result;
      } catch {
        return null;
      }
    },
    apply(text, ops) {
      let lines = text.split("\n");
      for (const op of ops) {
        const all = sections(lines);
        const own = (key: string) =>
          all.filter(
            (section) =>
              section.name === `${prefix}${key}` ||
              section.name.startsWith(`${prefix}${key}.`),
          );
        if (op.kind === "rename") {
          for (const section of own(op.key))
            lines[section.start] = lines[section.start].replace(
              `${prefix}${op.key}`,
              `${prefix}${op.to}`,
            );
          continue;
        }
        const existing = own(op.key);
        const replacement = op.kind === "set" ? render(op.key, op.value) : [];
        if (
          existing.length &&
          !replacement.length &&
          existing[existing.length - 1].end === lines.length
        ) {
          // The last section goes with the blank lines before it: undoing an append.
          let start = existing[0].start;
          while (start > 0 && lines[start - 1].trim() === "") start--;
          lines = [...lines.slice(0, start), ""];
        } else if (existing.length) {
          const start = existing[0].start;
          const end = existing[existing.length - 1].end;
          // Keep the blank line that separated this section from the next.
          const blank = end > start && lines[end - 1].trim() === "" ? [""] : [];
          lines = [
            ...lines.slice(0, start),
            ...(replacement.length ? [...replacement, ...blank] : []),
            ...lines.slice(end),
          ];
        } else if (replacement.length) {
          while (lines.length && lines[lines.length - 1] === "") lines.pop();
          lines = [...lines, ...(lines.length ? [""] : []), ...replacement, ""];
        }
      }
      return lines.join("\n");
    },
  };
}

// --- YAML: a top-level `<table>:` mapping of block-style entries -------------------------------

export function yamlEditor(table: string): Editor {
  const indentOf = (line: string) => line.length - line.trimStart().length;
  const isContent = (line: string) => line.trim() !== "";
  type Block = { key: string; start: number; end: number };
  const layout = (lines: string[]) => {
    const top = lines.findIndex((line) => line.trimEnd() === `${table}:`);
    if (top < 0) return null;
    let end = top + 1;
    while (
      end < lines.length &&
      (!isContent(lines[end]) || indentOf(lines[end]) > 0)
    )
      end++;
    // Trailing blank lines belong to whatever follows.
    while (end > top + 1 && !isContent(lines[end - 1])) end--;
    const childIndent = lines.slice(top + 1, end).find(isContent);
    const indent = childIndent ? indentOf(childIndent) : 2;
    const blocks: Block[] = [];
    for (let index = top + 1; index < end; index++) {
      const line = lines[index];
      if (!isContent(line) || indentOf(line) !== indent) continue;
      if (line.trimStart().startsWith("- "))
        throw new ManualEdit(`${table} is a YAML list, not a mapping`);
      const match = /^\s*([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (!match) throw new ManualEdit(`cannot read '${line.trim()}'`);
      if (blocks.length) blocks[blocks.length - 1].end = index;
      blocks.push({ key: match[1], start: index, end });
    }
    return { top, end, indent, blocks };
  };
  const read = (lines: string[], block: Block, indent: number): ServerValue => {
    const value: ServerValue = {};
    let list: unknown[] | null = null;
    for (const line of lines.slice(block.start + 1, block.end)) {
      if (!isContent(line) || line.trimStart().startsWith("#")) continue;
      const text = line.trim();
      if (list && text.startsWith("- ")) {
        list.push(parseScalar(text.slice(2)));
        continue;
      }
      if (indentOf(line) !== indent * 2)
        throw new ManualEdit(`unexpected nesting at '${text}'`);
      const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(text);
      if (!match) throw new ManualEdit(`cannot read '${text}'`);
      if (match[2] === "") {
        list = [];
        value[match[1]] = list;
      } else {
        list = null;
        value[match[1]] = parseScalar(match[2]);
      }
    }
    return value;
  };
  const render = (key: string, value: ServerValue, indent: number) => {
    const pad = " ".repeat(indent);
    const out = [`${pad}${key}:`];
    for (const field of ENTRY_KEYS) {
      const item = value[field];
      if (item === undefined) continue;
      if (Array.isArray(item)) {
        out.push(`${pad}${pad}${field}:`);
        for (const entry of item)
          out.push(`${pad}${pad}${pad}- ${quote(entry)}`);
      } else out.push(`${pad}${pad}${field}: ${quote(item)}`);
    }
    return out;
  };
  return {
    servers(text) {
      try {
        const lines = text.split("\n");
        const shape = layout(lines);
        if (!shape) return new Map();
        return new Map(
          shape.blocks.map((block) => [
            block.key,
            read(lines, block, shape.indent),
          ]),
        );
      } catch {
        return null;
      }
    },
    apply(text, ops) {
      let lines = text.split("\n");
      for (const op of ops) {
        const shape = layout(lines);
        if (!shape) {
          if (op.kind !== "set") continue;
          while (lines.length && lines[lines.length - 1] === "") lines.pop();
          lines = [
            ...lines,
            ...(lines.length ? [""] : []),
            `${table}:`,
            ...render(op.key, op.value, 2),
            "",
          ];
          continue;
        }
        const block = shape.blocks.find((item) => item.key === op.key);
        if (op.kind === "rename") {
          if (block)
            lines[block.start] = lines[block.start].replace(
              `${op.key}:`,
              `${op.to}:`,
            );
          continue;
        }
        const replacement =
          op.kind === "set" ? render(op.key, op.value, shape.indent) : [];
        if (block)
          lines = [
            ...lines.slice(0, block.start),
            ...replacement,
            ...lines.slice(block.end),
          ];
        else if (replacement.length)
          lines = [
            ...lines.slice(0, shape.end),
            ...replacement,
            ...lines.slice(shape.end),
          ];
      }
      return lines.join("\n");
    },
  };
}

// A client whose server table the editors cannot write (e.g. a YAML list): reads nothing,
// every change is a manual step.
export const manualEditor: Editor = {
  servers: () => null,
  apply() {
    throw new ManualEdit("this client's config format is edited by hand");
  },
};
