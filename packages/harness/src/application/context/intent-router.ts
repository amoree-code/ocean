// Deterministic intent router: pure text classification, no filesystem I/O, no model call,
// no MCP round trip. Runs before any retrieval so a caller (CLI, shim, hook, or MCP adapter)
// knows what Ocean operation — if any — a request maps to, without guessing an identifier or
// a project when the request does not name one clearly. See T-198 slice 4.

import {
  extractTaskIds,
  LEGACY_PREFIX,
} from "@ocean/core/domain/tasks/task-id.js";

type IntentCategory =
  | "task-lookup"
  | "task-create"
  | "memory-lookup"
  | "knowledge-lookup"
  | "work-style-lookup"
  | "project-detect"
  | "project-create"
  | "remember"
  | "decision-lookup"
  | "execute"
  | "unknown";

type EntityType =
  | "task"
  | "memory"
  | "knowledge"
  | "work-style"
  | "project"
  | "decision"
  | "execution"
  | "unknown";

type IntentAction =
  | "get"
  | "list"
  | "search"
  | "lookup"
  | "create"
  | "update"
  | "complete"
  | "continue"
  | "remember"
  | "execute"
  | "unknown";

export type IntentConfidence = "high" | "medium" | "low";

export type IntentClassification = {
  intent: IntentCategory;
  entityType: EntityType;
  identifier: string | null;
  action: IntentAction;
  confidence: IntentConfidence;
  ambiguityReason: string | null;
};

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

const TASK_COMPLETE = [
  /\b(complete|close|finish|done|archive)\b/i,
  /خلص|انهي|سكر|أرشف/,
];
const TASK_UPDATE = [/\b(update|edit|change)\b/i, /عدل|حدث|غير/];
const TASK_CONTINUE = [/\b(continue|resume)\b/i, /كمل|استمر/];
const TASK_CREATE = [
  /\b(create|new|open)\b[^.\n]*\btask\b/i,
  /\btask\b[^.\n]*\b(create|new|open)\b/i,
  /تكت جديدة|انشئ تكت|سوي تكت|افتح تكت/,
];
const TASK_CREATE_NAME =
  /\b(?:called|named|title(?:d)?)(?:\s+is)?\s+["']?(.+?)["']?(?:[.!?]|$)/i;

const SAVE_VERB = [/\bsave\b/i, /احفظ|خزن|سجل/];
const REMEMBER_VERB = [/\b(remember|note|capture)\b/i, /تذكر/];
const REMEMBER_TARGET = [/\b(this|that)\b/i, /هذا|هاي|هذه/];
const AS_DECISION = [/\bdecision\b/i, /قرار/];
const AS_KNOWLEDGE = [/\bknowledge\b|\blesson\b/i, /معرفة|درس/];

const DECISION_LOOKUP = [
  /\bwhat did we decide\b/i,
  /\bwhy did we (choose|pick|decide)\b/i,
  /\bdecision (about|on|for)\b/i,
  /\bwhat was the decision\b/i,
  /شنو قررنا|ليش اخترنا|ايش قررنا|القرار\s+(حول|بخصوص)/,
];

const WORK_STYLE = [
  /\bwork[- ]style\b/i,
  /\bhow (do|should) i (like to )?work\b/i,
  /\bmy (working )?preferences\b/i,
  /اسلوب العمل|طريقة (الشغل|العمل)/,
];

const PROJECT_CREATE = [
  /\b(start|create|begin)\b[^.\n]*\b(new )?project\b/i,
  /\bnew project\b/i,
  /مشروع جديد|سوي مشروع|انشئ مشروع/,
];
const PROJECT_CREATE_NAME =
  /\b(?:called|named)\s+["']?([\w .-]+?)["']?(?:[.!?]|$)/i;

const PROJECT_DETECT = [
  /\b(what|which) project\b/i,
  /\bcurrent project\b/i,
  /\bwhere am i\b/i,
  /شنو المشروع|اي مشروع|وين انا/,
];

const KNOWLEDGE_LOOKUP = [
  /\bknowledge\b/i,
  /\blesson(s)?\b/i,
  /\bwhat did we learn\b/i,
  /\bbest practice\b/i,
  /معرفة|درس|ايش تعلمنا/,
];

const MEMORY_LOOKUP = [
  /\bremember\b/i,
  /\brecall\b/i,
  /\bmemory\b/i,
  /\bwhat do you know about\b/i,
  /تتذكر|ذاكرة/,
];

const EXECUTE = [
  /\b(run|execute|deploy|launch)\b/i,
  /\bbuild\b/i,
  /\bstart (the )?(server|service|app|build)\b/i,
  /شغل|نفذ|ابني|شغّل/,
];

function safeResult(ambiguityReason: string): IntentClassification {
  return {
    intent: "unknown",
    entityType: "unknown",
    identifier: null,
    action: "unknown",
    confidence: "low",
    ambiguityReason,
  };
}

// taskPrefixes: the registered per-project prefixes, so "OL-001" is an id but "UTF-8" is not.
// The caller supplies them (the router stays pure and sync); the default is the legacy T.
export function classifyIntent(
  rawText: string,
  taskPrefixes: readonly string[] = [LEGACY_PREFIX],
): IntentClassification {
  const text = (rawText ?? "").trim();
  if (!text) return safeResult("empty request");

  const taskIds = extractTaskIds(text, taskPrefixes);
  if (taskIds.length > 1) {
    return safeResult(
      `multiple task identifiers found (${taskIds.join(", ")}); specify exactly one`,
    );
  }
  if (taskIds.length === 1) {
    const action: IntentAction = matchesAny(text, TASK_COMPLETE)
      ? "complete"
      : matchesAny(text, TASK_UPDATE)
        ? "update"
        : matchesAny(text, TASK_CONTINUE)
          ? "continue"
          : "get";
    return {
      intent: "task-lookup",
      entityType: "task",
      identifier: taskIds[0],
      action,
      confidence: "high",
      ambiguityReason: null,
    };
  }

  if (matchesAny(text, TASK_CREATE)) {
    const titleMatch = TASK_CREATE_NAME.exec(text);
    const identifier = titleMatch?.[1]?.trim() || null;
    return {
      intent: "task-create",
      entityType: "task",
      identifier,
      action: "create",
      confidence: identifier ? "high" : "medium",
      ambiguityReason: identifier
        ? null
        : "no task title captured ('called <title>' / 'named <title>')",
    };
  }

  const hasSaveVerb = matchesAny(text, SAVE_VERB);
  const hasRememberVerb = matchesAny(text, REMEMBER_VERB);
  const hasTarget =
    matchesAny(text, REMEMBER_TARGET) ||
    matchesAny(text, AS_DECISION) ||
    matchesAny(text, AS_KNOWLEDGE);
  // "remember"/"note" only count as a save command when they have an explicit target
  // ("this", "that", "as a decision", ...); bare "remember" (e.g. "what do you remember
  // about X") is a recall question, handled below by MEMORY_LOOKUP instead.
  if (hasSaveVerb || (hasRememberVerb && hasTarget)) {
    const entityType: EntityType = matchesAny(text, AS_DECISION)
      ? "decision"
      : matchesAny(text, AS_KNOWLEDGE)
        ? "knowledge"
        : "memory";
    return {
      intent: "remember",
      entityType,
      identifier: null,
      action: "remember",
      confidence: hasTarget ? "high" : "medium",
      ambiguityReason: hasTarget
        ? null
        : "no explicit content target ('this'/'that') named for the save",
    };
  }

  if (matchesAny(text, DECISION_LOOKUP)) {
    return {
      intent: "decision-lookup",
      entityType: "decision",
      identifier: null,
      action: "lookup",
      confidence: "high",
      ambiguityReason: null,
    };
  }

  if (matchesAny(text, WORK_STYLE)) {
    return {
      intent: "work-style-lookup",
      entityType: "work-style",
      identifier: null,
      action: "lookup",
      confidence: "high",
      ambiguityReason: null,
    };
  }

  if (matchesAny(text, PROJECT_CREATE)) {
    const nameMatch = PROJECT_CREATE_NAME.exec(text);
    const identifier = nameMatch ? nameMatch[1].trim() : null;
    return {
      intent: "project-create",
      entityType: "project",
      identifier,
      action: "create",
      confidence: identifier ? "high" : "medium",
      ambiguityReason: identifier
        ? null
        : "no project name captured ('called <name>' / 'named <name>')",
    };
  }

  if (matchesAny(text, PROJECT_DETECT)) {
    return {
      intent: "project-detect",
      entityType: "project",
      identifier: null,
      action: "lookup",
      confidence: "high",
      ambiguityReason: null,
    };
  }

  if (matchesAny(text, KNOWLEDGE_LOOKUP)) {
    return {
      intent: "knowledge-lookup",
      entityType: "knowledge",
      identifier: null,
      action: "search",
      confidence: "high",
      ambiguityReason: null,
    };
  }

  if (matchesAny(text, MEMORY_LOOKUP)) {
    return {
      intent: "memory-lookup",
      entityType: "memory",
      identifier: null,
      action: "search",
      confidence: "high",
      ambiguityReason: null,
    };
  }

  // "continue"/"resume" is checked before the execute verbs on purpose: in Arabic "شغل" is
  // both the noun "work" and the verb "run", so "كمل شغل اللوكين" ("continue the login
  // work") would otherwise be read as an execution request. Continue wording wins and the
  // result stays medium-confidence and ambiguous, which is the fail-closed direction.
  if (matchesAny(text, TASK_CONTINUE)) {
    return {
      intent: "task-lookup",
      entityType: "task",
      identifier: null,
      action: "continue",
      confidence: "medium",
      ambiguityReason:
        "'continue'/'resume' matched without an explicit task id or resolved project; could be a task or a project — confirm before retrieval",
    };
  }

  if (matchesAny(text, EXECUTE)) {
    return {
      intent: "execute",
      entityType: "execution",
      identifier: null,
      action: "execute",
      confidence: "high",
      ambiguityReason: null,
    };
  }

  return safeResult(
    "no recognizable entity, verb, or identifier matched in the request",
  );
}
