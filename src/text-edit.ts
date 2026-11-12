/** Replace `text.slice(start, end)` with `text`. Ranges come from the untouched original file. */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * Folds edits that sit inside another edit into it. Outer replacements are built from the original text of their
 * children (`serve({ fetch: h, port: Number(Deno.env.get("P")) })`), so the inner original text is swapped for the
 * inner replacement inside the outer one. Innermost first.
 */
export function foldNestedEdits(source: string, edits: TextEdit[]): TextEdit[] {
  const sorted = [...edits].sort((a, b) => a.end - a.start - (b.end - b.start));
  const out: TextEdit[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const inner = sorted[i]!;
    const outer = sorted.slice(i + 1).find((o) => o.start <= inner.start && inner.end <= o.end && o.end - o.start > inner.end - inner.start);
    if (!outer || inner.start === inner.end) {
      out.push(inner);
      continue;
    }
    const original = source.slice(inner.start, inner.end);
    const found = locate(outer.text, original, inner.start - outer.start);
    if (!found) throw new Error(`cannot fold edit at offset ${inner.start} into the edit at ${outer.start}`);
    const text = reindent(inner.text, found.shift);
    outer.text = outer.text.slice(0, found.at) + text + outer.text.slice(found.at + found.length);
  }
  return out;
}

/**
 * Finds `original` inside an outer replacement. The outer one may have re-indented its body (a Deno.test fn moved out
 * of an options object), so a multi-line original is also matched with each line's indentation shifted by the same
 * amount; `shift` is that amount (negative = moved left).
 */
function locate(haystack: string, original: string, expected: number): { at: number; length: number; shift: number } | null {
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lines = original.split("\n");
  const pattern = lines.map((l, i) => (i === 0 ? escape(l) : `[ \\t]*${escape(l.trimStart())}`)).join("\n");
  // The same text can appear twice (a test named "Deno.cwd()" around a Deno.cwd() call): take the match nearest to
  // where the inner edit sat in the original outer text. Earlier rewrites only move it by a little.
  let best: RegExpExecArray | null = null;
  for (const m of haystack.matchAll(new RegExp(pattern, "g"))) {
    if (!best || Math.abs(m.index - expected) < Math.abs(best.index - expected)) best = m;
  }
  if (!best) return null;
  const indent = (l: string): number => l.length - l.trimStart().length;
  const shift = lines.length < 2 ? 0 : indent(best[0].split("\n")[1]!) - indent(lines[1]!);
  return { at: best.index, length: best[0].length, shift };
}

function reindent(text: string, shift: number): string {
  if (!shift) return text;
  return text
    .split("\n")
    .map((l, i) => (i === 0 ? l : shift > 0 ? " ".repeat(shift) + l : l.replace(new RegExp(`^ {0,${-shift}}`), "")))
    .join("\n");
}

export function applyEdits(source: string, edits: TextEdit[]): string {
  const unique = [...new Map(edits.map((e) => [`${e.start}:${e.end}:${e.text}`, e])).values()];
  unique.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = source;
  let floor = Number.POSITIVE_INFINITY;
  for (const edit of unique) {
    if (edit.end > floor) throw new Error(`overlapping edits at offset ${edit.start}`);
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    floor = edit.start;
  }
  return out;
}
