import { normalizeText, tokenize } from "./text-tokens.js";

// Trigger words for policies and tool groups (T-339). The owner writes in Iraqi Arabic as often
// as in English, so a trigger is matched two ways: an English trigger by its stemmed words (all
// of them in the text, as profile triggers are), an Arabic one as a normalized substring, since
// Arabic attaches prefixes and suffixes to the word itself (دمج → ادمجه, الفرع → فرع).
// Deterministic, no model call.

const ARABIC = /[؀-ۿ]/;
// An Arabic trigger shorter than this would match inside unrelated words.
const ARABIC_MIN_CHARS = 3;
const MAX_TEXT = 2_000;

// Hamza forms, taa marbuta and alif maqsura folded; diacritics and tatweel dropped.
export function normalizeArabic(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي");
}

export type CompiledTrigger = {
  raw: string;
  arabic: boolean;
  // English: the stemmed content words. Arabic: the one normalized phrase.
  tokens: string[];
};

export function compileTriggers(
  triggers: readonly string[],
): CompiledTrigger[] {
  const out: CompiledTrigger[] = [];
  for (const raw of triggers) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    if (ARABIC.test(raw)) {
      const phrase = normalizeText(normalizeArabic(raw));
      if (phrase.replace(/ /g, "").length >= ARABIC_MIN_CHARS)
        out.push({ raw, arabic: true, tokens: [phrase] });
      continue;
    }
    const tokens = tokenize(raw);
    if (tokens.length) out.push({ raw, arabic: false, tokens });
  }
  return out;
}

export type PreparedText = { words: Set<string>; arabic: string };

export function prepareText(text: string): PreparedText {
  const head = text.slice(0, MAX_TEXT);
  return {
    words: new Set(tokenize(head)),
    arabic: ARABIC.test(head)
      ? ` ${normalizeText(normalizeArabic(head))} `
      : "",
  };
}

// The triggers that hit, by their raw spelling. A phrase (two words or more) is a strong hit.
export function triggerHits(
  compiled: readonly CompiledTrigger[],
  text: PreparedText,
): { hits: string[]; score: number } {
  const hits: string[] = [];
  let score = 0;
  for (const trigger of compiled) {
    const hit = trigger.arabic
      ? text.arabic.includes(trigger.tokens[0])
      : trigger.tokens.every((token) => text.words.has(token));
    if (!hit) continue;
    hits.push(trigger.raw);
    const words = trigger.arabic
      ? trigger.tokens[0].split(" ").length
      : trigger.tokens.length;
    score += words > 1 ? 2 : 1;
  }
  return { hits, score };
}

export function matchTriggers(
  triggers: readonly string[],
  text: string,
): { hits: string[]; score: number } {
  return triggerHits(compileTriggers(triggers), prepareText(text));
}
