// A project id names a folder under 04-projects, so it must be one plain path segment. It is
// lowercase because folders are case-insensitive on macOS and Windows: `Ocean-Language` and
// `ocean-language` would be two ids for one folder, and one write would clobber the other.
export const PROJECT_ID = /^[a-z0-9][a-z0-9._-]*$/;

// Who a project belongs to (T-311). A project lives in the folder of its category,
// 04-projects/<category>/<id>/; a new one lands in UNCATEGORIZED until it is moved.
export const PROJECT_CATEGORIES = [
  "company",
  "personal",
  "freelance",
  "former-company",
  "vendor",
] as const;
export type ProjectCategory = (typeof PROJECT_CATEGORIES)[number];
export const UNCATEGORIZED = "uncategorized";
// The folders directly under 04-projects that hold projects instead of being one.
export const PROJECT_CATEGORY_FOLDERS: readonly string[] = [
  ...PROJECT_CATEGORIES,
  UNCATEGORIZED,
];

export function isProjectCategory(value: unknown): value is ProjectCategory {
  return (PROJECT_CATEGORIES as readonly unknown[]).includes(value);
}

// A category folder name is never an id, so a flat folder and a category folder cannot be
// confused while both layouts are read.
export function isValidProjectId(value: string): boolean {
  return (
    PROJECT_ID.test(value) &&
    !value.includes("..") &&
    !PROJECT_CATEGORY_FOLDERS.includes(value)
  );
}
