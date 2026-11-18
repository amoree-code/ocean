// A title made from a client's raw first turn carries the harness's tags (`<system-reminder>…`,
// `<browser_instruction>…`, `<ide_opened_file>…`). The words inside a closed tag are the
// harness's, except a slash command's name and arguments; an opening tag left unclosed (the
// turn was cut short) takes everything after it. What is left, or the fallback, is the title.
export function cleanTitle(raw: string, fallback: string, max = 120): string {
  const text = raw
    .replace(/<([\w-]+)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, (whole, tag: string) =>
      /^(command-name|command-args)$/.test(tag)
        ? whole.replace(/<[^>]+>/g, " ")
        : " ",
    )
    .replace(/<[\w-]+(?:\s[^>]*)?>[\s\S]*$/, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/^[\s#>*-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return (text || fallback).slice(0, max);
}
