// main.ts is mend, the CLI SPEC.md specifies. It does all of SPEC.md: the command line, the output and exit
// codes, safe paths, format detection, JSON edits, unified diffs (section 6), SEARCH/REPLACE blocks
// (section 7), V4A patches (section 8), matching lines at three tiers (section 5), and the
// all-or-nothing write (section 10). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines plus its own line break and whether it ends with one (SPEC.md section 3). */
interface FileDoc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const body = final ? text.slice(0, -br.length) : text;
  return { lines: body.split(br), br, final };
}

function serializeFile(f: FileDoc): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Line matching (SPEC.md section 5)                                  */
/* ------------------------------------------------------------------ */

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Positions where O occurs in lines at the given tier, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (at or after `from`), with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line O[ctxIdx]) or an added line. */
interface NLine {
  text: string;
  ctxIdx: number | null;
}

/** Replace O at `pos` by N in the doc, honouring section 5 (context lines from the file, tier-2 re-indent). */
function applyAt(doc: FileDoc, o: string[], n: NLine[], pos: number, tier: number): FileDoc {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadingWs(doc.lines[pos] ?? '');
    p = leadingWs(o[0]!);
  }
  const out: string[] = [];
  for (const nl of n) {
    if (nl.ctxIdx !== null) {
      out.push(doc.lines[pos + nl.ctxIdx]!);
    } else if (tier === 2 && o.length > 0) {
      const t = nl.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(nl.text);
    }
  }
  return { lines: [...doc.lines.slice(0, pos), ...out, ...doc.lines.slice(pos + o.length)], br: doc.br, final: doc.final };
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                  */
/* ------------------------------------------------------------------ */

type BodyKind = 'ctx' | 'old' | 'new' | 'bs';
interface BodyEntry {
  kind: BodyKind;
  text: string;
  noEol: boolean;
}
interface Hunk {
  a: number;
  body: BodyEntry[];
  /** a `\` line follows the hunk's last context or `+` line */
  noEolLast: boolean;
}
interface USection {
  pairPresent: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( .*)?$/;

function parseHeaderPath(line: string): string | null {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const p = (tab >= 0 ? rest.slice(0, tab) : rest).trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Collect a hunk body starting at index `start`; returns the entries, the noEolLast flag and the next index. */
function collectBody(lines: string[], start: number): { body: BodyEntry[]; noEolLast: boolean; next: number } {
  const body: BodyEntry[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '', noEol: false });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1), noEol: false });
      j++;
      continue;
    }
    if (c === '-') {
      body.push({ kind: 'old', text: l.slice(1), noEol: false });
      j++;
      continue;
    }
    if (c === '+') {
      body.push({ kind: 'new', text: l.slice(1), noEol: false });
      j++;
      continue;
    }
    if (c === '\\') {
      body.push({ kind: 'bs', text: l.slice(1), noEol: false });
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0) {
    const e = body[body.length - 1]!;
    if (e.kind === 'ctx' && e.text === '') body.pop();
    else break;
  }
  for (let k = 0; k < body.length; k++) {
    if (body[k]!.kind === 'bs') {
      for (let m = k - 1; m >= 0; m--) {
        if (body[m]!.kind !== 'bs') {
          body[m]!.noEol = true;
          break;
        }
      }
    }
  }
  let noEolLast = false;
  for (let k = body.length - 1; k >= 0; k--) {
    const e = body[k]!;
    if (e.kind === 'ctx' || e.kind === 'new') {
      noEolLast = e.noEol;
      break;
    }
  }
  return { body, noEolLast, next: j };
}

function hunkON(h: Hunk): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const e of h.body) {
    if (e.kind === 'ctx') {
      o.push(e.text);
      n.push({ text: e.text, ctxIdx: o.length - 1 });
    } else if (e.kind === 'old') {
      o.push(e.text);
    } else if (e.kind === 'new') {
      n.push({ text: e.text, ctxIdx: null });
    }
  }
  return { o, n };
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let mode: 'prose' | 'header' | 'between' = 'prose';
  let i = 0;
  const startDiffSection = (line: string, ln: number): void => {
    const m = line.match(DIFF_RE);
    if (m === null) throw new Exit2(`error: parse ${ln}`);
    cur = {
      pairPresent: false,
      pairOld: null,
      pairNew: null,
      renameFrom: null,
      renameTo: null,
      diffOld: m[1]!,
      diffNew: m[2]!,
      create: false,
      del: false,
      hunks: [],
    };
    sections.push(cur);
    mode = 'header';
  };
  const startPairSection = (oldP: string | null, newP: string | null): void => {
    cur = {
      pairPresent: true,
      pairOld: oldP,
      pairNew: newP,
      renameFrom: null,
      renameTo: null,
      diffOld: null,
      diffNew: null,
      create: false,
      del: false,
      hunks: [],
    };
    sections.push(cur);
    mode = 'header';
  };
  const readHunk = (ln: number): void => {
    const l = lines[i]!;
    const m = l.match(HUNK_RE);
    if (m === null) throw new Exit2(`error: parse ${ln}`);
    const { body, noEolLast, next } = collectBody(lines, i + 1);
    cur!.hunks.push({ a: Number(m[1]), body, noEolLast });
    i = next;
    mode = 'between';
  };
  while (i < lines.length) {
    const l = lines[i]!;
    const ln = i + 1;
    if (l.startsWith('diff --git ')) {
      startDiffSection(l, ln);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = parseHeaderPath(l);
      const newP = parseHeaderPath(lines[i + 1]!);
      if (mode === 'header' && cur !== null && !cur.pairPresent) {
        cur.pairPresent = true;
        cur.pairOld = oldP;
        cur.pairNew = newP;
        i += 2;
        continue;
      }
      startPairSection(oldP, newP);
      i += 2;
      continue;
    }
    if (mode === 'prose') {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${ln}`);
      i++;
      continue;
    }
    if (mode === 'header') {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${ln + 1}`);
      if (l.startsWith('@@')) {
        readHunk(ln);
        continue;
      }
      if (l.startsWith('rename from ')) cur!.renameFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur!.renameTo = l.slice(10).trim();
      else if (l === 'new file mode' || l.startsWith('new file mode ')) cur!.create = true;
      else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) cur!.del = true;
      i++;
      continue;
    }
    // mode === 'between'
    if (l.startsWith('@@')) {
      readHunk(ln);
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

/** Apply a section's hunks in order to a doc (section 6); `failPath` names the file on no-match. */
function applyHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, failPath: string): FileDoc {
  let d = 0;
  let cur = doc;
  for (const h of hunks) {
    const { o, n } = hunkON(h);
    if (o.length === 0) {
      let at = h.a + d;
      if (at < 0) at = 0;
      if (at > cur.lines.length) at = cur.lines.length;
      const lines = [...cur.lines.slice(0, at), ...n.map((x) => x.text), ...cur.lines.slice(at)];
      let fin = cur.final;
      if (at === cur.lines.length) fin = !h.noEolLast;
      cur = { lines, br: cur.br, final: fin };
    } else {
      const found = findTier(cur.lines, o, strict, 0);
      if (found === null) throw new Fail('no-match', failPath);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const atEnd = best + o.length === cur.lines.length;
      const replaced = applyAt(cur, o, n, best, found.tier);
      cur = { ...replaced, final: atEnd ? !h.noEolLast : cur.final };
    }
    d += n.length - o.length;
  }
  return cur;
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  let oldP: string | null;
  let newP: string | null;
  if (sec.pairPresent) {
    oldP = sec.pairOld;
    newP = sec.pairNew;
  } else {
    oldP = sec.renameFrom ?? sec.diffOld;
    newP = sec.renameTo ?? sec.diffNew;
  }
  return (tree) => {
    if (sec.create || oldP === null) {
      const np = newP;
      if (np === null) return;
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let noEolLast = false;
      for (const h of sec.hunks) {
        for (const e of h.body) {
          if (e.kind === 'new') {
            plus.push(e.text);
            noEolLast = e.noEol;
          }
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noEolLast ? '' : '\n'));
      return;
    }
    if (sec.del || newP === null) {
      const op = oldP!;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(parseFile(cur), sec.hunks, strict, oldP);
      tree.now.set(newP, serializeFile(out));
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = oldP;
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const out = applyHunks(parseFile(cur), sec.hunks, strict, p);
    tree.now.set(p, serializeFile(out));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((s) => unifiedEdit(s, strict));
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                          */
/* ------------------------------------------------------------------ */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= searchFrom; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const cur = tree.get(p);
      if (oldLines.length === 0) {
        if (cur !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      if (cur === null) throw new Fail('missing', p);
      const doc = parseFile(cur);
      const found = findTier(doc.lines, oldLines, strict, 0);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const n: NLine[] = newLines.map((t) => ({ text: t, ctxIdx: null }));
      tree.now.set(p, serializeFile(applyAt(doc, oldLines, n, found.pos[0]!, found.tier)));
    });
    prevPath = p;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                    */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyEntry[];
}
interface VSectionEdit {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
  updateLine: number;
}

function isVSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function chunkON(c: VChunk): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const e of c.body) {
    if (e.kind === 'ctx') {
      o.push(e.text);
      n.push({ text: e.text, ctxIdx: o.length - 1 });
    } else if (e.kind === 'old') {
      o.push(e.text);
    } else if (e.kind === 'new') {
      n.push({ text: e.text, ctxIdx: null });
    }
  }
  return { o, n };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSectionEdit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    const ln = i + 1;
    if (blank(l)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice(14).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice(17).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${ln}`);
    }
    // Collect this section's raw lines (with line numbers) up to the next section or End Patch.
    const raw: Array<{ text: string; ln: number }> = [];
    let j = i + 1;
    while (j < last) {
      const rl = lines[j]!;
      if (isVSectionStart(rl)) break;
      raw.push({ text: rl, ln: j + 1 });
      j++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else if (r.text === '') addLines.push('');
        else throw new Exit2(`error: parse ${r.ln}`);
      }
      sections.push({ kind, path, moveTo: null, addLines, chunks: [], updateLine: ln });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.ln}`);
      sections.push({ kind, path, moveTo: null, addLines: [], chunks: [], updateLine: ln });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice(13).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let afterEof = false;
      for (; k < raw.length; k++) {
        const r = raw[k]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          cur = { anchor: t.slice(2).trim(), eof: false, body: [] };
          chunks.push(cur);
          afterEof = false;
          continue;
        }
        if (t.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.ln}`);
          cur.eof = true;
          afterEof = true;
          continue;
        }
        const c = t === '' ? '' : t[0]!;
        if (t === '' || c === ' ' || c === '-' || c === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          } else if (afterEof) {
            throw new Exit2(`error: parse ${r.ln}`);
          }
          cur.body.push({ kind: c === '' || c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new', text: t === '' ? '' : t.slice(1), noEol: false });
          continue;
        }
        throw new Exit2(`error: parse ${r.ln}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${ln}`);
      sections.push({ kind, path, moveTo, addLines: [], chunks, updateLine: ln });
    }
    i = j;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => {
    if (s.kind === 'add') {
      const p = s.path;
      const addLines = s.addLines;
      return (tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
      };
    }
    if (s.kind === 'delete') {
      const p = s.path;
      return (tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    const p = s.path;
    const moveTo = s.moveTo;
    const chunks = s.chunks;
    return (tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      let doc = parseFile(cur);
      let cursor = 0;
      for (const chunk of chunks) {
        if (chunk.anchor !== null && chunk.anchor !== '') {
          const found = findTier(doc.lines, [chunk.anchor], strict, cursor);
          if (found === null) throw new Fail('no-match', p);
          cursor = found.pos[0]! + 1;
        }
        const { o, n } = chunkON(chunk);
        if (o.length === 0) {
          let at = chunk.eof ? doc.lines.length : cursor;
          if (at < 0) at = 0;
          if (at > doc.lines.length) at = doc.lines.length;
          doc = { lines: [...doc.lines.slice(0, at), ...n.map((x) => x.text), ...doc.lines.slice(at)], br: doc.br, final: doc.final };
          cursor = at + n.length;
        } else {
          const found = findTier(doc.lines, o, strict, cursor);
          if (found === null) throw new Fail('no-match', p);
          let pos = found.pos[0]!;
          if (chunk.eof) {
            const ok = found.pos.filter((x) => x + o.length === doc.lines.length);
            if (ok.length === 0) throw new Fail('no-match', p);
            pos = ok[0]!;
          }
          doc = applyAt(doc, o, n, pos, found.tier);
          cursor = pos + n.length;
        }
      }
      const text = serializeFile(doc);
      if (moveTo !== null) {
        tree.now.set(moveTo, text);
        tree.now.set(p, null);
        tree.moves.push([p, moveTo]);
      } else {
        tree.now.set(p, text);
      }
    };
  });
}

/* ------------------------------------------------------------------ */
/* Driver (SPEC.md sections 1, 2 and 10)                              */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  const moveMap = new Map<string, string>();
  for (const [o, n] of tree.moves) moveMap.set(o, n);
  const resolved = new Map<string, string>();
  for (const o of moveMap.keys()) {
    let cur = o;
    const seen = new Set<string>([o]);
    while (moveMap.has(cur)) {
      const nx = moveMap.get(cur)!;
      if (seen.has(nx)) break;
      seen.add(nx);
      cur = nx;
    }
    resolved.set(o, cur);
  }
  for (const [o, n] of resolved) {
    if (o === n) continue;
    const wasO = tree.original(o);
    const nowO = tree.get(o);
    const wasN = tree.original(n);
    const nowN = tree.get(n);
    if (wasO !== null && nowO === null && wasN === null && nowN !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      covered.add(o);
      covered.add(n);
      if (!check) {
        rmSync(o, { force: true });
        mkdirSync(dirname(n), { recursive: true });
        writeFileSync(n, nowN);
      }
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
