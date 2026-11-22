// mend — one patch tool for every AI edit format (SPEC.md v1).
// Supports unified diff, search/replace blocks, V4A patches, and JSON
// patches, plus the CLI behaviour of the spec. Node 22, stdlib only.

import { runTrial } from './runner.ts';
import {
  mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

// ---------------------------------------------------------------- helpers

function trimEndWs(s) { return s.replace(/[ \t]+$/, ''); }
function isBlank(s) { return s.trim() === ''; }
function leadWs(s) { const m = /^[ \t]*/.exec(s); return m ? m[0] : ''; }

function byteCompare(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return Buffer.compare(ba, bb);
}

function isSafePath(p) {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// Split patch text into lines: split at \n, one trailing \r removed from
// each line, and no empty piece after a final \n.
function splitLines(text) {
  if (text === '') return [];
  const parts = text.split('\n');
  const out = [];
  for (let p of parts) {
    if (p.endsWith('\r')) p = p.slice(0, -1);
    out.push(p);
  }
  if (text.endsWith('\n')) out.pop();
  return out;
}

// ------------------------------------------------------------ file model

// A file is { lines, br, eol }: lines without line breaks, br is '\n' or
// '\r\n' (CRLF iff the first LF follows a CR), eol says whether the file
// ends with a line break.
function parseFileText(text) {
  let br = '\n';
  const nl = text.indexOf('\n');
  if (nl > 0 && text[nl - 1] === '\r') br = '\r\n';
  if (text === '') return { lines: [], br, eol: false };
  const parts = text.split(br);
  let eol = false;
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
    eol = true;
  }
  return { lines: parts, br, eol };
}

function serializeFile(f) {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.eol ? f.br : '');
}

// Load the working tree (all files, relative POSIX paths) into a Map.
function loadTree(root) {
  const out = new Map();
  const walk = (d) => {
    let names;
    try { names = readdirSync(d); } catch { return; }
    for (const name of names) {
      const p = join(d, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        const rel = relative(root, p).split(sep).join('/');
        let text;
        try { text = readFileSync(p, 'utf8'); } catch { continue; }
        out.set(rel, parseFileText(text));
      }
    }
  };
  walk(root);
  return out;
}

// -------------------------------------------------------------- matching

function normLine(s, tier) {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function linesEqual(a, b, tier) { return normLine(a, tier) === normLine(b, tier); }

function findOccurrences(fileLines, oldLines, tier) {
  const out = [];
  if (oldLines.length === 0) return out;
  for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (!linesEqual(fileLines[i + j], oldLines[j], tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

// First tier (0, then 1, then 2; strict = 0 only) with at least one
// occurrence at or after fromIdx. Returns { tier, occ } or null.
function findTier(fileLines, oldLines, strict, fromIdx) {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(fileLines, oldLines, t).filter((i) => i >= fromIdx);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// Build the replacement lines for an occurrence at pos. Each entry of N is
// { text, ctx }: ctx >= 0 means a context line (write the file's own matched
// line at pos + ctx); ctx === -1 means a new line. At tier 2, new lines are
// re-indented: leading P (of O's first line) replaced by F (of the file's
// first matched line), for non-empty, non-whitespace-only lines.
function buildReplacement(fileLines, pos, oldLines, newEntries, tier) {
  const out = [];
  let p = '';
  let f = '';
  if (tier === 2 && oldLines.length > 0) {
    p = leadWs(oldLines[0]);
    f = leadWs(fileLines[pos]);
  }
  for (const e of newEntries) {
    if (e.ctx >= 0) {
      out.push(fileLines[pos + e.ctx]);
    } else if (tier === 2) {
      const t = e.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(e.text);
    }
  }
  return out;
}

// Turn a body (list of { k, t } where k is ' ', '-', '+' or '\') into
// O (context + old lines) and N (list of { text, ctx }).
function hunkON(body) {
  const O = [];
  const N = [];
  for (const b of body) {
    if (b.k === ' ') { O.push(b.t); N.push({ text: b.t, ctx: O.length - 1 }); }
    else if (b.k === '-') { O.push(b.t); }
    else if (b.k === '+') { N.push({ text: b.t, ctx: -1 }); }
  }
  return { O, N };
}

// True when a '\' line follows the body's last context or '+' line.
function backslashAfterLastCtxPlus(body) {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i].k === ' ' || body[i].k === '+') last = i;
  }
  if (last === -1) return false;
  return last + 1 < body.length && body[last + 1].k === '\\';
}

// ---------------------------------------------------------- CLI arguments

// Returns { format, check, strict, patch } or { error: 'usage' }.
// Options and PATCH may come in any order; '--' ends option parsing.
function parseArgs(argv) {
  let format = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  const positional = [];
  let endOpts = false;
  for (const a of argv) {
    if (!endOpts && a === '--') { endOpts = true; continue; }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) return { error: 'usage' };
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return { error: 'usage' };
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) return { error: 'usage' };
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') {
          return { error: 'usage' };
        }
        format = v;
      } else {
        return { error: 'usage' };
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return { error: 'usage' };
  return { format, check, strict, patch: positional.length === 1 ? positional[0] : null };
}

// ------------------------------------------------------- format detection

// Auto-detection, first rule that holds: v4a, then json, then
// search-replace, then unified. Returns a format name or null.
function detectFormat(lines) {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) { first = i; break; }
  }
  if (first === -1) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const firstNonWs = lines[first].replace(/^\s+/, '');
  if (firstNonWs.startsWith('[') || firstNonWs.startsWith('{')) return 'json';
  for (let i = 0; i < lines.length; i++) {
    if (trimEndWs(lines[i]) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      return 'unified';
    }
  }
  return null;
}

// ------------------------------------------------------------ unified diff

function parseUnified(lines) {
  const sections = [];
  let cur = null;
  let i = 0;
  const n = lines.length;

  const newSection = () => {
    cur = {
      oldP: undefined, newP: undefined,
      renameFrom: undefined, renameTo: undefined,
      diffOld: undefined, diffNew: undefined,
      newFile: false, deletedFile: false, hasPair: false, hunks: [],
    };
    sections.push(cur);
    return cur;
  };

  // Path from a '--- ' or '+++ ' line: text after the first 4 chars, up to
  // the first tab, surrounding spaces removed; a leading a/ or b/ removed;
  // '/dev/null' means no file (null).
  const headerPath = (line) => {
    let t = line.slice(4);
    const tab = t.indexOf('\t');
    if (tab !== -1) t = t.slice(0, tab);
    t = t.trim();
    if (t === '/dev/null') return null;
    if (t.startsWith('a/')) t = t.slice(2);
    else if (t.startsWith('b/')) t = t.slice(2);
    return t;
  };

  const bodyLine = (b) => {
    if (b === '') return { k: ' ', t: '' };
    const c = b[0];
    if (c === ' ' || c === '-' || c === '+' || c === '\\') return { k: c, t: b.slice(1) };
    return { k: '?', t: b };
  };

  while (i < n) {
    const L = lines[i];
    if (L.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(L);
      if (!m) throw { parseLine: i + 1 };
      const s = newSection();
      s.diffOld = m[1];
      s.diffNew = m[2];
      i++;
      continue;
    }
    if (L.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      if (cur && cur.hunks.length === 0 && !cur.hasPair) {
        cur.oldP = headerPath(L);
        cur.newP = headerPath(lines[i + 1]);
        cur.hasPair = true;
      } else {
        const s = newSection();
        s.oldP = headerPath(L);
        s.newP = headerPath(lines[i + 1]);
        s.hasPair = true;
      }
      i += 2;
      continue;
    }
    if (L.startsWith('--- ')) {
      // A lone '--- ' line inside a section header is a parse error at the
      // line after it; anywhere else it is prose and is ignored.
      if (cur && cur.hunks.length === 0) throw { parseLine: i + 2 };
      i++;
      continue;
    }
    if (L.startsWith('@@')) {
      if (!cur) throw { parseLine: i + 1 };
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(L);
      if (!hm) throw { parseLine: i + 1 };
      const A = parseInt(hm[1], 10);
      const rawBody = [];
      let j = i + 1;
      while (j < n) {
        const B = lines[j];
        if (B.startsWith('diff --git ')) break;
        if (B.startsWith('--- ') && j + 1 < n && lines[j + 1].startsWith('+++ ')) break;
        if (B.startsWith(' ') || B.startsWith('-') || B.startsWith('+') || B.startsWith('\\') || B === '') {
          rawBody.push(B);
          j++;
        } else break;
      }
      while (rawBody.length > 0 && rawBody[rawBody.length - 1] === '') rawBody.pop();
      cur.hunks.push({ A, body: rawBody.map(bodyLine) });
      i = j;
      continue;
    }
    if (cur && cur.hunks.length === 0) {
      if (L.startsWith('rename from ')) cur.renameFrom = L.slice('rename from '.length).trim();
      else if (L.startsWith('rename to ')) cur.renameTo = L.slice('rename to '.length).trim();
      else if (L.startsWith('new file mode')) cur.newFile = true;
      else if (L.startsWith('deleted file mode')) cur.deletedFile = true;
      // index, old mode, new mode, similarity, dissimilarity, Index: and
      // other header lines are ignored.
    }
    i++;
  }

  if (sections.length === 0) throw { parseLine: 1 };
  const edits = [];
  for (const s of sections) {
    const oldP = s.hasPair ? s.oldP : (s.renameFrom !== undefined ? s.renameFrom : s.diffOld);
    const newP = s.hasPair ? s.newP : (s.renameTo !== undefined ? s.renameTo : s.diffNew);
    let kind;
    let path;
    let newPath;
    if (oldP === null || s.newFile) { kind = 'create'; path = newP; }
    else if (newP === null || s.deletedFile) { kind = 'delete'; path = oldP; }
    else if (oldP !== newP) { kind = 'move'; path = oldP; newPath = newP; }
    else { kind = 'change'; path = oldP; }
    edits.push({ format: 'unified', kind, path, newPath, hunks: s.hunks });
  }
  return edits;
}

// --------------------------------------------------------- search-replace

function parseSearchReplace(lines) {
  const edits = [];
  let prevEnd = -1; // index of the previous block's '>>>>>>> REPLACE' line
  let prevPath = null;
  for (let s = 0; s < lines.length; s++) {
    if (trimEndWs(lines[s]) !== '<<<<<<< SEARCH') continue;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (trimEndWs(lines[j]) === '=======') { eq = j; break; }
    }
    let rep = -1;
    if (eq !== -1) {
      for (let k = eq + 1; k < lines.length; k++) {
        if (trimEndWs(lines[k]) === '>>>>>>> REPLACE') { rep = k; break; }
      }
    }
    if (eq === -1 || rep === -1) throw { parseLine: s + 1 };
    // The path is the nearest line before the SEARCH marker, after the
    // previous block's REPLACE line (or the start of the patch), that is
    // not blank and whose trimmed form does not start with a code fence.
    let path = null;
    for (let p = s - 1; p > prevEnd; p--) {
      const L = lines[p];
      if (isBlank(L)) continue;
      if (L.trim().startsWith('```')) continue;
      path = L.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw { parseLine: s + 1 };
    }
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push({ format: 'search-replace', path, oldLines, newLines });
    prevPath = path;
    prevEnd = rep;
  }
  if (edits.length === 0) throw { parseLine: 1 };
  return edits;
}

// --------------------------------------------------------------------- V4A

function parseV4A(lines) {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) { if (first === -1) first = i; last = i; }
  }
  if (first === -1) throw { parseLine: 1 };
  if (lines[first].trim() !== '*** Begin Patch') throw { parseLine: first + 1 };
  if (lines[last].trim() !== '*** End Patch') throw { parseLine: lines.length + 1 };

  const isSectionStart = (L) =>
    L.startsWith('*** Add File: ') || L.startsWith('*** Delete File: ') || L.startsWith('*** Update File: ');

  const edits = [];
  let i = first + 1;
  while (i < last) {
    const L = lines[i];
    if (isBlank(L)) { i++; continue; }
    if (L.startsWith('*** Add File: ')) {
      const path = L.slice('*** Add File: '.length).trim();
      const flines = [];
      let j = i + 1;
      while (j < last) {
        const B = lines[j];
        if (isSectionStart(B)) break;
        if (B.startsWith('+')) { flines.push(B.slice(1)); j++; }
        else if (B === '') { flines.push(''); j++; }
        else if (isBlank(B)) { j++; } // blank separator, not a file line
        else throw { parseLine: j + 1 };
      }
      while (flines.length > 0 && flines[flines.length - 1] === '') flines.pop();
      edits.push({ format: 'v4a', kind: 'add', path, flines });
      i = j;
      continue;
    }
    if (L.startsWith('*** Delete File: ')) {
      const path = L.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last) {
        const B = lines[j];
        if (isSectionStart(B)) break;
        if (isBlank(B)) { j++; continue; }
        throw { parseLine: j + 1 };
      }
      edits.push({ format: 'v4a', kind: 'delete', path });
      i = j;
      continue;
    }
    if (L.startsWith('*** Update File: ')) {
      const path = L.slice('*** Update File: '.length).trim();
      let j = i + 1;
      // Blank lines between the section header and the Move to line are
      // separators, so skip them before looking for it.
      while (j < last && isBlank(lines[j])) j++;
      let moveTo = null;
      if (j < last && lines[j].startsWith('*** Move to: ')) {
        moveTo = lines[j].slice('*** Move to: '.length).trim();
        j++;
      }
      const chunks = [];
      let curChunk = null;
      let pendingBlanks = 0; // blank lines seen with no chunk open
      const finishChunk = (atSectionEnd) => {
        if (!curChunk) return;
        if (atSectionEnd) {
          while (curChunk.body.length > 0 && isBlank(curChunk.body[curChunk.body.length - 1].raw)) {
            curChunk.body.pop();
          }
        }
        chunks.push(curChunk);
        curChunk = null;
      };
      const openChunk = (anchor) => {
        curChunk = { anchor, eof: false, body: [] };
        for (let q = 0; q < pendingBlanks; q++) {
          curChunk.body.push({ raw: '', k: ' ', t: '' });
        }
        pendingBlanks = 0;
      };
      while (j < last) {
        const B = lines[j];
        if (isSectionStart(B)) break;
        if (B.startsWith('@@')) {
          finishChunk(false);
          openChunk(B.slice(2).trim());
          j++;
          continue;
        }
        if (B === '*** End of File') {
          if (!curChunk) throw { parseLine: j + 1 };
          curChunk.eof = true;
          finishChunk(false);
          j++;
          continue;
        }
        if (isBlank(B) && !curChunk) {
          pendingBlanks++;
          j++;
          continue;
        }
        if (B.startsWith(' ') || B.startsWith('-') || B.startsWith('+') || B === '') {
          if (!curChunk) openChunk(null);
          curChunk.body.push({ raw: B, k: B === '' ? ' ' : B[0], t: B === '' ? '' : B.slice(1) });
          j++;
          continue;
        }
        throw { parseLine: j + 1 };
      }
      finishChunk(true);
      if (chunks.length === 0 && moveTo === null) throw { parseLine: i + 1 };
      edits.push({ format: 'v4a', kind: 'update', path, moveTo, chunks });
      i = j;
      continue;
    }
    throw { parseLine: i + 1 };
  }
  if (edits.length === 0) throw { parseLine: 1 };
  return edits;
}

// -------------------------------------------------------------------- JSON

function validateJSONEdit(o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return null;
  if (typeof o.path !== 'string' || typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { format: 'json', command: 'create', path: o.path, file_text: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str === undefined) o = { ...o, new_str: '' };
    if (typeof o.new_str !== 'string') return null;
    return { format: 'json', command: 'str_replace', path: o.path, old_str: o.old_str, new_str: o.new_str };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { format: 'json', command: 'insert', path: o.path, insert_line: o.insert_line, new_str: o.new_str };
  }
  return null;
}

function parseJSON(lines, patchText) {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) { first = i; break; }
  }
  if (first === -1) throw { parseLine: 1 };
  const firstCh = lines[first].replace(/^\s+/, '')[0];
  if (firstCh === '[') {
    let arr;
    try { arr = JSON.parse(patchText); } catch { throw { parseLine: first + 1 }; }
    if (!Array.isArray(arr)) throw { parseLine: first + 1 };
    const edits = [];
    for (const el of arr) {
      const e = validateJSONEdit(el);
      if (!e) throw { parseLine: first + 1 };
      edits.push(e);
    }
    if (edits.length === 0) throw { parseLine: 1 };
    return edits;
  }
  const edits = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { throw { parseLine: i + 1 }; }
    const e = validateJSONEdit(obj);
    if (!e) throw { parseLine: i + 1 };
    edits.push(e);
  }
  if (edits.length === 0) throw { parseLine: 1 };
  return edits;
}

// ------------------------------------------------------- edit application

// Moves that succeeded in this run, as [old, new] pairs, for the R lines.
const movePairs = [];

function pathExists(tree, p) {
  if (tree.has(p)) return true;
  const prefix = p + '/';
  for (const k of tree.keys()) { if (k.startsWith(prefix)) return true; }
  return false;
}

// True when a proper ancestor of p is itself a file in the tree.
function hasFileAncestor(tree, p) {
  const parts = p.split('/');
  let cur = '';
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur === '' ? parts[i] : cur + '/' + parts[i];
    if (tree.has(cur)) return true;
  }
  return false;
}

// Apply a hunk list to a file's lines. Returns { file } or { fail: true }.
// The file's own line break is kept; the final break follows the spec: it
// stays as it was unless the matched lines run to the end of the file (or,
// for an empty O, the insertion is at the end), in which case the result
// ends with a break unless a '\' line follows the hunk's last context or
// '+' line.
function applyHunksToFile(file, hunks, strict) {
  let lines = file.lines.slice();
  let eol = file.eol;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = hunkON(h.body);
    const flag = backslashAfterLastCtxPlus(h.body);
    if (O.length === 0) {
      let at = h.A + d;
      if (at < 0) at = 0;
      if (at > lines.length) at = lines.length;
      const ins = N.map((e) => e.text);
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...ins);
      if (atEnd) eol = !flag;
      d += N.length;
      continue;
    }
    const found = findTier(lines, O, strict, 0);
    if (!found) return { fail: true };
    // The occurrence nearest to A - 1 + d; ties go to the earlier one.
    const target = h.A - 1 + d;
    let best = found.occ[0];
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) { best = p; bestDist = dist; }
    }
    const pos = best;
    const matchedToEnd = pos + O.length === lines.length;
    const replaced = buildReplacement(lines, pos, O, N, found.tier);
    lines.splice(pos, O.length, ...replaced);
    if (matchedToEnd) eol = !flag;
    d += N.length - O.length;
  }
  return { file: { lines, br: file.br, eol } };
}

// The last '+' line across all hunks of a creation, and whether a '\' line
// follows it in the same hunk body.
function lastPlusBackslash(hunks) {
  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const body = hunks[hi].body;
    for (let bi = body.length - 1; bi >= 0; bi--) {
      if (body[bi].k === '+') {
        return bi + 1 < body.length && body[bi + 1].k === '\\';
      }
    }
  }
  return false;
}

function applyUnified(edit, tree, strict) {
  const { kind, path, newPath, hunks } = edit;
  const bad = (p) => {
    if (p === null || p === undefined || p === '') return { code: 'unsafe', path: p ?? '' };
    if (!isSafePath(p)) return { code: 'unsafe', path: p };
    return null;
  };
  if (kind === 'create') {
    const b = bad(path);
    if (b) return b;
    if (pathExists(tree, path)) return { code: 'exists', path };
    if (hasFileAncestor(tree, path)) return { code: 'unsafe', path };
    const plus = [];
    for (const h of hunks) {
      for (const bodyLine of h.body) { if (bodyLine.k === '+') plus.push(bodyLine.t); }
    }
    const eol = plus.length > 0 ? !lastPlusBackslash(hunks) : false;
    tree.set(path, { lines: plus, br: '\n', eol });
    return null;
  }
  if (kind === 'delete') {
    const b = bad(path);
    if (b) return b;
    if (!tree.has(path)) return { code: 'missing', path };
    tree.delete(path);
    return null;
  }
  const bOld = bad(path);
  if (bOld) return bOld;
  if (kind === 'move') {
    const bNew = bad(newPath);
    if (bNew) return bNew;
  }
  if (!tree.has(path)) return { code: 'missing', path };
  if (kind === 'move') {
    if (pathExists(tree, newPath)) return { code: 'exists', path: newPath };
    if (hasFileAncestor(tree, newPath)) return { code: 'unsafe', path: newPath };
  }
  const file = tree.get(path);
  const res = applyHunksToFile(file, hunks, strict);
  if (res.fail) return { code: 'no-match', path };
  if (kind === 'move') {
    tree.delete(path);
    tree.set(newPath, res.file);
    movePairs.push([path, newPath]);
  } else {
    tree.set(path, res.file);
  }
  return null;
}

function applySearchReplace(edit, tree, strict) {
  const { path, oldLines, newLines } = edit;
  if (!isSafePath(path)) return { code: 'unsafe', path };
  if (oldLines.length === 0) {
    if (pathExists(tree, path)) return { code: 'exists', path };
    if (hasFileAncestor(tree, path)) return { code: 'unsafe', path };
    tree.set(path, { lines: newLines.slice(), br: '\n', eol: newLines.length > 0 });
    return null;
  }
  if (!tree.has(path)) return { code: 'missing', path };
  const file = tree.get(path);
  const found = findTier(file.lines, oldLines, strict, 0);
  if (!found) return { code: 'no-match', path };
  if (found.occ.length > 1) return { code: 'ambiguous', path };
  const pos = found.occ[0];
  const N = newLines.map((t) => ({ text: t, ctx: -1 }));
  const replaced = buildReplacement(file.lines, pos, oldLines, N, found.tier);
  const lines = file.lines.slice();
  lines.splice(pos, oldLines.length, ...replaced);
  tree.set(path, { lines, br: file.br, eol: file.eol });
  return null;
}

function applyV4A(edit, tree, strict) {
  const { kind, path, moveTo, flines, chunks } = edit;
  if (!isSafePath(path)) return { code: 'unsafe', path };
  if (kind === 'add') {
    if (pathExists(tree, path)) return { code: 'exists', path };
    if (hasFileAncestor(tree, path)) return { code: 'unsafe', path };
    tree.set(path, { lines: flines.slice(), br: '\n', eol: flines.length > 0 });
    return null;
  }
  if (kind === 'delete') {
    if (!tree.has(path)) return { code: 'missing', path };
    tree.delete(path);
    return null;
  }
  // update
  if (moveTo) {
    if (!isSafePath(moveTo)) return { code: 'unsafe', path: moveTo };
  }
  if (!tree.has(path)) return { code: 'missing', path };
  if (moveTo) {
    if (pathExists(tree, moveTo)) return { code: 'exists', path: moveTo };
    if (hasFileAncestor(tree, moveTo)) return { code: 'unsafe', path: moveTo };
  }
  const file = tree.get(path);
  let lines = file.lines.slice();
  let cursor = 0;
  for (const ch of chunks) {
    const { O, N } = hunkON(ch.body);
    if (ch.anchor !== null && ch.anchor !== undefined) {
      // First line at or after the cursor equal to the anchor, at the
      // first tier where one exists.
      let foundIdx = -1;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        for (let idx = cursor; idx < lines.length; idx++) {
          if (linesEqual(lines[idx], ch.anchor, t)) { foundIdx = idx; break; }
        }
        if (foundIdx !== -1) break;
      }
      if (foundIdx === -1) return { code: 'no-match', path };
      cursor = foundIdx + 1;
    }
    if (O.length === 0) {
      const at = ch.eof ? lines.length : cursor;
      const ins = N.map((e) => e.text);
      lines.splice(at, 0, ...ins);
      cursor = at + ins.length;
    } else {
      // First tier with an occurrence at or after the cursor; an EOF chunk
      // takes only an occurrence that ends at the file's last line.
      let foundTier = -1;
      let pos = -1;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        const occ = findOccurrences(lines, O, t);
        for (const p of occ) {
          if (p < cursor) continue;
          if (ch.eof && p + O.length !== lines.length) continue;
          foundTier = t;
          pos = p;
          break;
        }
        if (pos !== -1) break;
      }
      if (pos === -1) return { code: 'no-match', path };
      const replaced = buildReplacement(lines, pos, O, N, foundTier);
      lines.splice(pos, O.length, ...replaced);
      cursor = pos + replaced.length;
    }
  }
  const newFile = { lines, br: file.br, eol: file.eol };
  if (moveTo) {
    tree.delete(path);
    tree.set(moveTo, newFile);
    movePairs.push([path, moveTo]);
  } else {
    tree.set(path, newFile);
  }
  return null;
}

function applyJSON(edit, tree) {
  const { command, path } = edit;
  if (!isSafePath(path)) return { code: 'unsafe', path };
  if (command === 'create') {
    if (pathExists(tree, path)) return { code: 'exists', path };
    if (hasFileAncestor(tree, path)) return { code: 'unsafe', path };
    tree.set(path, parseFileText(edit.file_text));
    return null;
  }
  if (command === 'str_replace') {
    if (!tree.has(path)) return { code: 'missing', path };
    const file = tree.get(path);
    const text = serializeFile(file);
    const isCRLF = file.br === '\r\n';
    let hay = text;
    let oldS = edit.old_str;
    let newS = edit.new_str;
    if (isCRLF) {
      hay = text.split('\r\n').join('\n');
      oldS = edit.old_str.split('\r\n').join('\n');
      newS = edit.new_str.split('\r\n').join('\n');
    }
    // Count overlapping occurrences; more than one is ambiguous.
    let count = 0;
    let firstIdx = -1;
    let idx = 0;
    while (true) {
      const at = hay.indexOf(oldS, idx);
      if (at === -1) break;
      if (firstIdx === -1) firstIdx = at;
      count++;
      if (count > 1) break;
      idx = at + 1;
    }
    if (count === 0) return { code: 'no-match', path };
    if (count > 1) return { code: 'ambiguous', path };
    let result = hay.slice(0, firstIdx) + newS + hay.slice(firstIdx + oldS.length);
    if (isCRLF) result = result.split('\n').join('\r\n');
    tree.set(path, parseFileText(result));
    return null;
  }
  // insert
  if (!tree.has(path)) return { code: 'missing', path };
  const file = tree.get(path);
  const n = file.lines.length;
  if (edit.insert_line < 0 || edit.insert_line > n) return { code: 'no-match', path };
  const newLines = splitLines(edit.new_str);
  const lines = file.lines.slice();
  lines.splice(edit.insert_line, 0, ...newLines);
  tree.set(path, { lines, br: file.br, eol: file.eol });
  return null;
}

function applyEdit(edit, tree, strict) {
  if (edit.format === 'unified') return applyUnified(edit, tree, strict);
  if (edit.format === 'search-replace') return applySearchReplace(edit, tree, strict);
  if (edit.format === 'v4a') return applyV4A(edit, tree, strict);
  return applyJSON(edit, tree);
}

// ------------------------------------------------------------- main flow

// Build the change list (A/D/M/R lines) from the initial snapshot and the
// simulated tree, sorted by path in UTF-8 byte order (R lines sort by the
// new path). Files whose bytes are unchanged are not listed.
function computeChanges(initial, tree) {
  const changes = [];
  const coveredOld = new Set();
  const coveredNew = new Set();
  for (const [oldP, newP] of movePairs) {
    if (initial.has(oldP) && !tree.has(oldP) && !initial.has(newP) && tree.has(newP)) {
      changes.push({ kind: 'R', old: oldP, new: newP, sortKey: newP });
      coveredOld.add(oldP);
      coveredNew.add(newP);
    }
  }
  const allPaths = new Set([...initial.keys(), ...tree.keys()]);
  for (const p of allPaths) {
    if (coveredOld.has(p) || coveredNew.has(p)) continue;
    const before = initial.get(p);
    const afterF = tree.get(p);
    if (before === undefined && afterF !== undefined) {
      changes.push({ kind: 'A', path: p, sortKey: p });
    } else if (before !== undefined && afterF === undefined) {
      changes.push({ kind: 'D', path: p, sortKey: p });
    } else if (before !== undefined && afterF !== undefined) {
      if (before !== serializeFile(afterF)) {
        changes.push({ kind: 'M', path: p, sortKey: p });
      }
    }
  }
  changes.sort((a, b) => byteCompare(a.sortKey, b.sortKey));
  return changes;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stdout.write('error: usage\n');
    process.exitCode = 2;
    return;
  }

  let patchText;
  if (args.patch === null || args.patch === '-') {
    try { patchText = readFileSync(0, 'utf8'); }
    catch { patchText = ''; }
  } else {
    try { patchText = readFileSync(args.patch, 'utf8'); }
    catch {
      process.stdout.write('error: no-patch\n');
      process.exitCode = 2;
      return;
    }
  }

  const lines = splitLines(patchText);
  const format = args.format === 'auto' ? detectFormat(lines) : args.format;
  if (format === null) {
    process.stdout.write('error: format\n');
    process.exitCode = 2;
    return;
  }

  let edits;
  try {
    if (format === 'unified') edits = parseUnified(lines);
    else if (format === 'search-replace') edits = parseSearchReplace(lines);
    else if (format === 'v4a') edits = parseV4A(lines);
    else edits = parseJSON(lines, patchText);
  } catch (e) {
    if (e && typeof e.parseLine === 'number') {
      process.stdout.write(`error: parse ${e.parseLine}\n`);
      process.exitCode = 2;
      return;
    }
    throw e;
  }

  // Simulate the whole patch against the working tree.
  const root = process.cwd();
  const tree = loadTree(root);
  const initial = new Map();
  for (const [p, f] of tree) initial.set(p, serializeFile(f));
  const failures = [];
  for (const edit of edits) {
    const fail = applyEdit(edit, tree, args.strict);
    if (fail) failures.push(fail);
  }
  if (failures.length > 0) {
    let out = '';
    for (const f of failures) out += `error: ${f.code} ${f.path}\n`;
    out += `failed: ${failures.length} of ${edits.length} edits\n`;
    process.stdout.write(out);
    process.exitCode = 1;
    return;
  }

  const changes = computeChanges(initial, tree);
  let out = '';
  for (const c of changes) {
    if (c.kind === 'R') out += `R ${c.old} -> ${c.new}\n`;
    else out += `${c.kind} ${c.path}\n`;
  }
  out += changes.length === 1 ? 'ok: 1 file\n' : `ok: ${changes.length} files\n`;
  process.stdout.write(out);

  if (!args.check) {
    for (const [p, f] of tree) {
      const after = serializeFile(f);
      if (initial.get(p) !== after) {
        const full = join(root, ...p.split('/'));
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, after);
      }
    }
    for (const p of initial.keys()) {
      if (!tree.has(p)) {
        const full = join(root, ...p.split('/'));
        try { unlinkSync(full); } catch {}
      }
    }
  }
  process.exitCode = 0;
}

// When the grader hands over a trial, run it; otherwise run the tool.
if (process.env.MAKEFUN_ENV_URL) {
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  main();
}
