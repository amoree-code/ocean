const DEFAULT_SKILLS = [
  "design-thinking",
  "business-logic",
  "core-thinking",
  "verification",
  "loop",
] as const;

export function defaultSkillNames(_role: string): string[] {
  const role = _role.toLowerCase();
  if (role.includes("research"))
    return [
      "design-thinking",
      "business-logic",
      "core-thinking",
      "verification",
    ];
  if (role.includes("test"))
    return [
      "design-thinking",
      "business-logic",
      "verification",
      "use-browser",
      "loop",
    ];
  if (role.includes("developer") || role.includes("engineer"))
    return [...DEFAULT_SKILLS, "use-browser"];
  return [...DEFAULT_SKILLS, "use-browser"];
}
