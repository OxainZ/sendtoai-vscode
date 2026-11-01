// ── Parsing an AI chat reply into file edits ──────────────────────────────────
// Pure functions, no vscode import, unit-tested in test/extension.test.cjs.
//
// Accepted shapes (every placement observed across GPT, Claude and Gemini):
//   1. Fenced full file, path in the fence info string:   ```ts src/a.ts
//   2. Fenced full file, path on the line just above:     **src/a.ts** / `src/a.ts` / File: src/a.ts
//   3. Fenced full file, path as a first-line comment:    // src/a.ts  |  # src/a.py  |  <!-- a.html -->
//   4. SEARCH/REPLACE blocks (aider / Brud style), inside or outside a fence:
//        src/a.ts
//        <<<<<<< SEARCH
//        old lines
//        =======
//        new lines
//        >>>>>>> REPLACE
// Fences may be ``` or ~~~ and any length >= 3; the closing fence must use the
// same character and be at least as long, so a README containing ``` inside a
// ```` block does not end the block early.

export type ReplyEdit =
  | { path: string; kind: 'full'; content: string }
  | { path: string; kind: 'replace'; edits: { search: string; replace: string }[] };

export function extractPathToken(s: string): string {
  const cleaned = s.replace(/\\/g, '/').replace(/[*`>#]/g, '').replace(/^\s*(?:file|path)\s*:/i, '').trim();
  const m = cleaned.match(/([\w][\w./-]*\.[A-Za-z][A-Za-z0-9]{0,7})\b/);
  return m ? m[1] : '';
}

/** A line that is essentially JUST a path (label line), not prose that mentions one. */
function labelPath(line: string): string {
  const tok = extractPathToken(line);
  if (!tok) { return ''; }
  const cleaned = line.replace(/[*`>#]/g, '').replace(/^\s*(?:file|path)\s*:/i, '').trim();
  return cleaned.length <= tok.length + 24 ? tok : '';
}

// Recognises `// src/a.ts`, `# src/a.py`, `<!-- src/a.html -->`, a CSS block comment, `-- a.sql`
function commentPath(line: string): string {
  const m = line.match(/^\s*(?:\/\/|#|--|<!--|\/\*)\s*(?:file|path)?\s*:?\s*([^\s*>]+)\s*(?:-->|\*\/)?\s*$/i);
  if (!m) { return ''; }
  const tok = extractPathToken(m[1]);
  return tok && tok === m[1].replace(/\\/g, '/') ? tok : '';
}

const SR_OPEN = /^\s*<{5,9} *SEARCH\s*$/;
const SR_MID = /^\s*={5,9}\s*$/;
const SR_CLOSE = /^\s*>{5,9} *REPLACE\s*$/;

function parseSearchReplace(lines: string[], start: number): { edits: { search: string; replace: string }[]; end: number } | null {
  const edits: { search: string; replace: string }[] = [];
  let i = start;
  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === '') { i++; }
    if (i >= lines.length || !SR_OPEN.test(lines[i])) { break; }
    i++;
    const search: string[] = [];
    while (i < lines.length && !SR_MID.test(lines[i])) { search.push(lines[i]); i++; }
    if (i >= lines.length) { return null; }
    i++;
    const replace: string[] = [];
    while (i < lines.length && !SR_CLOSE.test(lines[i])) { replace.push(lines[i]); i++; }
    if (i >= lines.length) { return null; }
    i++;
    edits.push({ search: search.join('\n'), replace: replace.join('\n') });
  }
  return edits.length ? { edits, end: i } : null;
}

export function parseReply(text: string): ReplyEdit[] {
  const out: ReplyEdit[] = [];
  const lines = text.split(/\r?\n/);
  let pending = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const mark = fence[1];
      const closeRe = new RegExp(`^\\s*${mark[0] === '`' ? '`' : '~'}{${mark.length},}\\s*$`);
      let p = extractPathToken(fence[2]) || pending;
      i++;
      const buf: string[] = [];
      while (i < lines.length && !closeRe.test(lines[i])) { buf.push(lines[i]); i++; }
      pending = '';

      // Path as a first-line comment, or a bare path line right before SEARCH/REPLACE
      let body = buf;
      const first = body.findIndex(l => l.trim() !== '');
      if (first >= 0) {
        const cp = commentPath(body[first]);
        const bare = labelPath(body[first]);
        const nextIsSR = body.slice(first + 1).find(l => l.trim() !== '');
        if (cp && (!p || cp === p)) { p = cp; body = body.slice(first + 1); }
        else if (!p && bare && nextIsSR && SR_OPEN.test(nextIsSR)) { p = bare; body = body.slice(first + 1); }
      }
      if (!p) { continue; }

      const sr = parseSearchReplace(body, 0);
      if (sr) { out.push({ path: p, kind: 'replace', edits: sr.edits }); }
      else { out.push({ path: p, kind: 'full', content: body.join('\n') }); }
      continue;
    }

    // Raw SEARCH/REPLACE outside a fence, path on the label line above
    if (SR_OPEN.test(line) && pending) {
      const sr = parseSearchReplace(lines, i);
      if (sr) { out.push({ path: pending, kind: 'replace', edits: sr.edits }); i = sr.end - 1; pending = ''; continue; }
    }

    if (line.trim() === '') { continue; } // blank lines keep a pending label alive
    pending = labelPath(line);          // prose ("e.g.", "Node.js") never becomes a target
  }
  return out;
}

/** Back-compat: only the full-file blocks. */
export function parseFileBlocks(text: string): { path: string; content: string }[] {
  return parseReply(text).flatMap(e => e.kind === 'full' ? [{ path: e.path, content: e.content }] : []);
}

// ── Applying SEARCH/REPLACE edits ────────────────────────────────────────────
// Exact match first. Otherwise match line-by-line with trailing whitespace and
// CRLF differences ignored, which is where models most often drift. A search
// that matches nowhere or in more than one place is reported, not guessed.
export interface ApplyResult { content: string; applied: number; failed: string[] }

export function applySearchReplace(original: string, edits: { search: string; replace: string }[]): ApplyResult {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let text = original;
  let applied = 0;
  const failed: string[] = [];

  for (const { search, replace } of edits) {
    if (search === '') { failed.push('empty SEARCH block'); continue; }
    const srch = search.replace(/\r\n/g, '\n');
    const repl = replace.replace(/\r\n/g, '\n').split('\n').join(eol);

    // 1. exact (after normalising the reply's EOLs to the file's)
    const exact = srch.split('\n').join(eol);
    const first = text.indexOf(exact);
    if (first >= 0 && text.indexOf(exact, first + 1) < 0) {
      text = text.slice(0, first) + repl + text.slice(first + exact.length);
      applied++;
      continue;
    }
    if (first >= 0) { failed.push(`ambiguous (matches more than once): ${srch.split('\n')[0]}`); continue; }

    // 2. tolerant: compare lines with trailing whitespace trimmed
    const fileLines = text.split(eol);
    const want = srch.split('\n').map(l => l.trimEnd());
    const hits: number[] = [];
    for (let i = 0; i + want.length <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < want.length; j++) {
        if (fileLines[i + j].trimEnd() !== want[j]) { ok = false; break; }
      }
      if (ok) { hits.push(i); }
    }
    if (hits.length === 1) {
      fileLines.splice(hits[0], want.length, ...repl.split(eol));
      text = fileLines.join(eol);
      applied++;
    } else if (hits.length === 0) {
      failed.push(`not found: ${want[0] || '(blank)'}`);
    } else {
      failed.push(`ambiguous (matches ${hits.length} times): ${want[0]}`);
    }
  }
  return { content: text, applied, failed };
}

/** The instruction appended to every bundle so replies come back in a shape we can apply. */
export const REPLY_FORMAT_INSTRUCTION = [
  'HOW TO REPLY WITH CODE CHANGES (they can then be applied to the project automatically):',
  '- For each changed file, give the COMPLETE file in one fenced block whose opening line is',
  '  ```<language> <path>   for example   ```ts src/app.ts   (paths relative to the project root above).',
  '- Or use SEARCH/REPLACE blocks for small edits:',
  '  src/app.ts',
  '  <<<<<<< SEARCH',
  '  exact existing lines',
  '  =======',
  '  replacement lines',
  '  >>>>>>> REPLACE',
  '- Never shorten a full-file block with "... existing code ..." or similar.',
].join('\n');
