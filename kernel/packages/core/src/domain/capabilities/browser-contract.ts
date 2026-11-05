import { z } from "zod";
import {
  type CapabilityContract,
  capabilityContractSchema,
} from "./capability-contract.js";

const browserOperationSchema = z.enum([
  "open",
  "close",
  "approve",
  "navigate",
  "read",
  "observe",
  "extract",
  "click",
  "type",
  "replace-text",
  "select",
  "scroll",
  "wait",
  "upload",
  "download",
  "submit",
]);
export type BrowserOperation = z.infer<typeof browserOperationSchema>;

// "required" always needs owner approval before execution; "conditional" needs it only
// when the application layer determines the specific call crosses a trust boundary
// (navigate: only when the destination origin differs from the session's current origin).
const browserApprovalSchema = z.enum(["none", "required", "conditional"]);
type BrowserApproval = z.infer<typeof browserApprovalSchema>;

const browserCapabilityContractSchema = capabilityContractSchema.extend({
  capability: z.literal("browser"),
  operation: browserOperationSchema,
  approval: browserApprovalSchema,
});
export type BrowserCapabilityContract = z.infer<
  typeof browserCapabilityContractSchema
>;

function define(
  operation: BrowserOperation,
  authority: CapabilityContract["authority"],
  idempotency: CapabilityContract["idempotency"],
  approval: BrowserApproval,
  verification: string,
): BrowserCapabilityContract {
  return browserCapabilityContractSchema.parse({
    capability: "browser",
    operation,
    authority,
    idempotency,
    approval,
    verification,
  });
}

// authority/idempotency/approval mirror the retired Python prototype's per-operation
// authority (observe/execute/execute-with-approval) and idempotent flag, translated onto
// this codebase's authority scopes (profile/session/owner) plus an orthogonal approval
// gate. Every read-only operation stays session-scoped and safe; state-changing
// operations are session-scoped and non-repeatable; upload/download/submit and
// cross-origin navigation require owner approval.
export const browserContracts: Record<
  BrowserOperation,
  BrowserCapabilityContract
> = {
  open: define(
    "open",
    "session",
    "non-repeatable",
    "none",
    "session record reaches status running with a live CDP endpoint",
  ),
  close: define(
    "close",
    "session",
    "repeatable",
    "none",
    "session record reaches a terminal status and the browser process has exited",
  ),
  approve: define(
    "approve",
    "owner",
    "repeatable",
    "required",
    "session approval is persisted and expires when the browser session closes",
  ),
  navigate: define(
    "navigate",
    "session",
    "repeatable",
    "conditional",
    "live page URL matches the requested destination",
  ),
  read: define(
    "read",
    "session",
    "safe",
    "none",
    "returned text is re-read from the live page, not cached",
  ),
  observe: define(
    "observe",
    "session",
    "safe",
    "none",
    "returned elements are re-read from the live page, not cached",
  ),
  extract: define(
    "extract",
    "session",
    "safe",
    "none",
    "returned values are re-read from the live page via the given selector",
  ),
  click: define(
    "click",
    "session",
    "non-repeatable",
    "none",
    "the caller's expected outcome (navigation, staying on the page, or a selector's live element count) is re-checked against live state after the click",
  ),
  type: define(
    "type",
    "session",
    "non-repeatable",
    "none",
    "live input value is re-read from the target element after typing",
  ),
  "replace-text": define(
    "replace-text",
    "session",
    "non-repeatable",
    "none",
    "the live editor value contains the requested replacement and the selected occurrence was unique or explicit",
  ),
  select: define(
    "select",
    "session",
    "non-repeatable",
    "none",
    "live input value is re-read from the target element after selecting",
  ),
  scroll: define(
    "scroll",
    "session",
    "repeatable",
    "none",
    "live scroll position is re-read after scrolling",
  ),
  wait: define(
    "wait",
    "session",
    "safe",
    "none",
    "the awaited selector or URL pattern is confirmed present on the live page",
  ),
  upload: define(
    "upload",
    "owner",
    "non-repeatable",
    "required",
    "live file input reports the attached file names",
  ),
  download: define(
    "download",
    "owner",
    "non-repeatable",
    "required",
    "downloaded file exists on disk with a non-zero size at the reported path",
  ),
  submit: define(
    "submit",
    "owner",
    "non-repeatable",
    "required",
    "live page URL and load state are re-read after submission",
  ),
};
