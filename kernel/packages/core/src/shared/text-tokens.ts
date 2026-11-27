// The words a text is matched on, shared by the skill router and the profile resolver so a
// prompt meets a skill and a profile the same way: lowercased, NFKC, letters and digits only,
// stop words out, a light suffix strip.

const STOP_WORDS = new Set(
  (
    "a an the and or but if of to in on at by for with from as is are was were be been being " +
    "it its this that these those i me my we our us you your he she they them their what which " +
    "who whom how when where why can could should would will shall do does did done doing have " +
    "has had not no yes so than then there here about into over under up down out any all some " +
    "each every more most other such only own same too very just also use used using user users " +
    "owner says say said ask asks asked want wants need needs please let lets get got make made " +
    "via per etc skill skills like one two new now way well really thing things help"
  ).split(" "),
);

export const isContentWord = (word: string) =>
  word.length >= 2 && !STOP_WORDS.has(word);

export function normalizeText(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKC")
      .match(/[\p{L}\p{N}]+/gu)
      ?.join(" ") ?? ""
  );
}

// Light suffix stripping so "writing tests" meets "write a test"; the same on both sides.
export function stem(word: string): string {
  let out = word;
  if (out.length > 5 && out.endsWith("ing")) out = out.slice(0, -3);
  else if (out.length > 4 && out.endsWith("ed")) out = out.slice(0, -2);
  else if (out.length > 4 && out.endsWith("es")) out = out.slice(0, -2);
  else if (out.length > 3 && out.endsWith("s") && !out.endsWith("ss"))
    out = out.slice(0, -1);
  if (out.length > 3 && out.endsWith("e")) out = out.slice(0, -1);
  return out;
}

export function tokenize(text: string): string[] {
  return normalizeText(text).split(" ").filter(isContentWord).map(stem);
}
