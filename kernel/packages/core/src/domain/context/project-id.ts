// A project id names a folder under 04-projects, so it must be one plain path segment. It is
// lowercase because folders are case-insensitive on macOS and Windows: `Ocean-Language` and
// `ocean-language` would be two ids for one folder, and one write would clobber the other.
export const PROJECT_ID = /^[a-z0-9][a-z0-9._-]*$/;

export function isValidProjectId(value: string): boolean {
  return PROJECT_ID.test(value) && !value.includes("..");
}
