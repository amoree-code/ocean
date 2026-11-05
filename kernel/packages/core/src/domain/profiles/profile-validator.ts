import { type Profile, profileSchema } from "./profile.js";

export function validateProfile(input: unknown): Profile {
  return profileSchema.parse(input);
}
