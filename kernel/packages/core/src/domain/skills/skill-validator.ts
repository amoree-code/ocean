import { type Skill, skillSchema } from "./skill.js";

export function validateSkill(input: unknown): Skill {
  return skillSchema.parse(input);
}
