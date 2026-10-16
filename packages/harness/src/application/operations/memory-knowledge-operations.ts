import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  normalizeScope,
  scopeVisible,
} from "@ocean/core/domain/brain/record-scope.js";
import type { BrainIndexPort } from "@ocean/core/domain/ports/brain-index-port.js";
import {
  atomicWrite,
  FRONTMATTER_READ_BYTES,
} from "@ocean/core/shared/fs-utils.js";
import {
  KNOWLEDGE_DIR,
  oceanRoot,
  PERSONAL_DIR,
  resolveWithin,
  STORE_DIR,
} from "@ocean/core/shared/paths.js";
import { resolveProject } from "@ocean/core/shared/project-resolution.js";
import { brainIndexPath } from "../brain/brain-reindex.js";
import { BrainIndexStaleError, brainSearch } from "../brain/brain-service.js";
import type { ContextBudget } from "../context/context-ladder.js";
import type { RecordType } from "../context/context-packet.js";
import type { IntentClassification } from "../context/intent-router.js";
import {
  approvalMatchesTarget,
  type OperationRecord,
  type OperationResult,
  operationResult,
  selectFields,
  shapeRecords,
  validateSlug,
  validateWriteTarget,
  type WriteApproval,
} from "./operation-contract.js";
import type { OperationOptions } from "./operation-scope.js";
import {
  freshnessFor,
  listRecordFiles,
  readFrontmatterFile,
  relativeToOcean,
  requireAbsentTarget,
} from "./record-io.js";

const KNOWLEDGE_KINDS = [
  "architecture",
  "decisions",
  "discoveries",
  "failures",
  "references",
  "research",
  "results",
  "solutions",
];

const RECORD_FIELDS = [
  "name",
  "description",
  "id",
  "title",
  "summary",
  "type",
  "status",
  "confidence",
  "updated",
];

function provenanceFor(
  recordType: RecordType,
  fields: Record<string, string>,
): OperationRecord["provenance"] {
  const declared = (fields.provenance ?? fields.type ?? "").toLowerCase();
  if (
    [
      "fact",
      "preference",
      "decision",
      "lesson",
      "proposal",
      "temporary-note",
    ].includes(declared)
  )
    return declared as OperationRecord["provenance"];
  if (recordType === "task") return "task";
  if (recordType === "project") return "project";
  if (recordType === "execution") return "execution";
  return recordType === "knowledge"
    ? "lesson"
    : recordType === "memory"
      ? "temporary-note"
      : "unknown";
}

function matchesQuery(
  fields: Record<string, string>,
  file: string,
  query: string,
): boolean {
  if (!query) return true;
  const haystack = `${path.basename(file)} ${fields.name ?? fields.id ?? ""} ${
    fields.description ?? fields.summary ?? ""
  } ${fields.title ?? ""}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

// Best-effort: the brain index is disposable and may not exist (a fresh checkout, a fixture
// root in tests, or a corpus that has never been reindexed). Any failure here — missing
// index, corrupt file — falls back to the substring path below rather than surfacing an
// error a caller of memory.search/knowledge.search never asked for.
async function searchViaBrainIndex(
  recordType: RecordType,
  _rootSegments: string[],
  classification: IntentClassification,
  budget: ContextBudget,
  query: string,
  indexPort: BrainIndexPort,
  project: string | null,
  notes: string[],
): Promise<OperationRecord[] | null> {
  const root = oceanRoot();
  try {
    await stat(brainIndexPath(root));
  } catch {
    return null;
  }
  // The index stores "<store>/<relative path>"; the store is the record type here.
  const store = recordType === "knowledge" ? "knowledge" : "memory";
  const pathPrefix = store;
  try {
    const result = await brainSearch({
      query,
      root,
      pathPrefix: pathPrefix ? `${pathPrefix}/` : undefined,
      limit: Math.min(20, budget.maxFiles),
      scope: { project },
      indexPort,
    });
    return result.results.map((hit) => ({
      identifier: hit.id,
      recordType,
      provenance: provenanceFor(recordType, { type: hit.type }),
      sourcePath: `${STORE_DIR[store]}/${hit.path.slice(store.length + 1)}`,
      freshness: "unknown" as const,
      confidence: classification.confidence,
      selectionReason: `ranked by brain index (${result.mode})`,
      fields: selectFields(
        {
          id: hit.id,
          title: hit.title,
          summary: hit.summary,
          type: hit.type,
          confidence: hit.confidence,
          updated: hit.lastConfirmedAt ?? "",
        },
        RECORD_FIELDS,
      ),
    }));
  } catch (error) {
    // A stale index is the one failure worth naming: the fallback still answers, but the
    // caller should know why ranking is gone and how to get it back.
    if (error instanceof BrainIndexStaleError) notes.push(error.message);
    return null;
  }
}

export async function searchRecords(
  operation: "memory.search" | "knowledge.search",
  recordType: RecordType,
  rootSegments: string[],
  classification: IntentClassification,
  budget: ContextBudget,
  options: OperationOptions,
): Promise<OperationResult> {
  let root: string;
  try {
    root = resolveWithin(oceanRoot(), ...rootSegments);
  } catch {
    return operationResult(operation, "record root escapes the Ocean root");
  }

  // Search shows global records plus the cwd's project. An unbound cwd, or a registry that
  // cannot be read, narrows to global — and the failure is reported, not swallowed.
  let project: string | null = null;
  const scopeViolations: string[] = [];
  try {
    const resolution = await resolveProject(options.cwd ?? process.cwd());
    if (resolution.status === "bound") project = resolution.projectId;
  } catch (error) {
    scopeViolations.push(
      `project unresolved: ${error instanceof Error ? error.message : String(error)}; global records only`,
    );
  }

  if (options.query && options.indexPort) {
    const viaIndex = await searchViaBrainIndex(
      recordType,
      rootSegments,
      classification,
      budget,
      options.query,
      options.indexPort,
      project,
      scopeViolations,
    );
    if (viaIndex) {
      const shaped = shapeRecords(viaIndex, budget.maxFiles);
      return {
        operation,
        ok: true,
        reason: `${shaped.records.length} ${recordType} reference(s) selected`,
        records: shaped.records,
        violations: [...scopeViolations, ...shaped.violations],
        written: null,
        packet: null,
      };
    }
  }

  const files = await listRecordFiles(root);
  const records: OperationRecord[] = [];
  const violations: string[] = [];
  let bytes = 0;
  for (const file of files) {
    const record = await readFrontmatterFile(file);
    if (!record) continue;
    if (!scopeVisible(normalizeScope(record.fields.scope).scope, project))
      continue;
    if (!matchesQuery(record.fields, file, options.query ?? "")) continue;
    bytes += Math.min(record.size, FRONTMATTER_READ_BYTES);
    if (bytes > budget.maxBytes) {
      violations.push(
        `max-bytes-exceeded: stopped searching at ${bytes} bytes (budget ${budget.maxBytes})`,
      );
      break;
    }
    records.push({
      identifier:
        record.fields.name ?? record.fields.id ?? path.basename(file, ".md"),
      recordType,
      provenance: provenanceFor(recordType, record.fields),
      sourcePath: relativeToOcean(file),
      freshness: freshnessFor(record.mtimeMs),
      confidence: classification.confidence,
      selectionReason: options.query
        ? `metadata match on query '${options.query}'`
        : `${recordType} record index entry`,
      fields: selectFields(record.fields, RECORD_FIELDS),
    });
  }
  const shaped = shapeRecords(records, budget.maxFiles);
  return {
    operation,
    ok: true,
    reason: `${shaped.records.length} ${recordType} reference(s) selected`,
    records: shaped.records,
    violations: [...scopeViolations, ...violations, ...shaped.violations],
    written: null,
    packet: null,
  };
}

// Canonical brain-record frontmatter (T-228): every new write emits this flat shape
// directly — id/title/summary/tags/type/confidence/created/updated/last_confirmed_at — plus
// provenance/status/correction_of, which are Ocean operation metadata, not part of the
// brain-record schema itself, but useful alongside it. Existing files with the legacy
// name/description/metadata:{...} shape are read through aliases (brain-markdown.ts) and are
// never rewritten by this function.
function recordDocument(
  slug: string,
  recordType: string,
  content: string,
  provenance: OperationRecord["provenance"],
  correctionOf?: string,
): string {
  const today = new Date().toISOString().slice(0, 10);
  const correction = correctionOf ? `\ncorrection_of: ${correctionOf}` : "";
  return `---\nid: ${slug}\ntitle: ${slug}\nsummary: ""\ntags: []\ntype: ${recordType}\nconfidence: unknown\ncreated: ${today}\nupdated: ${today}\nlast_confirmed_at: ${today}\nprovenance: ${provenance}\nstatus: current${correction}\n---\n\n${content.trim()}\n`;
}

export async function writeRecord(
  operation: "memory.write" | "knowledge.write",
  options: OperationOptions,
  budget: ContextBudget,
): Promise<OperationResult> {
  const slug = validateSlug(options.slug, "record slug");
  if (!slug.valid)
    return operationResult(operation, `write refused: ${slug.reason}`);
  const content = options.content;
  if (typeof content !== "string" || content.trim().length === 0)
    return operationResult(
      operation,
      "write refused: no explicit content supplied",
    );
  if (Buffer.byteLength(content, "utf8") > budget.maxBytes) {
    return operationResult(
      operation,
      `write refused: content is ${Buffer.byteLength(content, "utf8")} bytes, budget.maxBytes allows ${budget.maxBytes}`,
      { violations: ["max-bytes-exceeded"] },
    );
  }
  if (
    options.correctionOf !== undefined &&
    (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(options.correctionOf) ||
      options.correctionOf.includes(".."))
  ) {
    return operationResult(
      operation,
      "write refused: correctionOf must be an explicit safe record identifier",
    );
  }

  let segments: string[];
  let recordType: string;
  if (operation === "memory.write") {
    segments = [PERSONAL_DIR, `${slug.value}.md`];
    recordType = "memory";
  } else {
    const kind = validateSlug(options.kind, "knowledge kind");
    if (!kind.valid)
      return operationResult(operation, `write refused: ${kind.reason}`);
    if (!KNOWLEDGE_KINDS.includes(kind.value))
      return operationResult(
        operation,
        `write refused: '${kind.value}' is not an allowed knowledge kind`,
      );
    segments = [KNOWLEDGE_DIR, kind.value, `${slug.value}.md`];
    recordType = kind.value === "decisions" ? "decision" : "knowledge";
  }

  const target = validateWriteTarget(...segments);
  if (!target.valid)
    return operationResult(operation, `write refused: ${target.reason}`);
  const approvalCheck = approvalMatchesTarget(
    options.approval as WriteApproval,
    target.value,
  );
  if (!approvalCheck.ok)
    return operationResult(operation, approvalCheck.reason);
  const absent = await requireAbsentTarget(target.value);
  if (!absent.ok)
    return operationResult(operation, `write refused: ${absent.reason}`);

  try {
    await mkdir(path.dirname(target.value), { recursive: true });
    const provenance =
      options.provenance ??
      (options.correctionOf
        ? "fact"
        : recordType === "memory"
          ? "temporary-note"
          : recordType === "decision"
            ? "decision"
            : "lesson");
    const bytes = await atomicWrite(
      target.value,
      recordDocument(
        slug.value,
        recordType,
        content,
        provenance,
        options.correctionOf,
      ),
    );
    return {
      operation,
      ok: true,
      reason: `${recordType} record '${slug.value}' written`,
      records: [],
      violations: [],
      written: { sourcePath: relativeToOcean(target.value), bytes },
      packet: null,
    };
  } catch (error) {
    return operationResult(
      operation,
      `write failed atomically, no partial content left: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
