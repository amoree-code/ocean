import {
  type Session,
  sessionSchema,
} from "@ocean/core/domain/sessions/session.js";

export function validateSession(input: unknown): Session {
  return sessionSchema.parse(input);
}
