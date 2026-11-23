// main.ts is mend, the CLI SPEC.md specifies: it applies an edit in one of four formats (unified diff, SEARCH/REPLACE,
// V4A patch, JSON) to a tree of text files, matching lines at three tiers (section 5), and writes every file or none.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** Split a file's text into its line break, its lines and whether it ends with a break (SPEC.md section 3). */
function splitFile(text: string): { br: string; lines: string[]; final: boolean } {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** A line's comparison key at a tier (SPEC.md section 5): 0 exact, 1 trailing spaces/tabs off, 2 both sides off. */
function lineKey(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** Every position >= from where O's lines match the file's lines at the tier; occurrences may overlap. */
function occurrences(o: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const keys = o.map((l) => lineKey(l, tier));
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (lineKey(lines[i + k]!, tier) !== keys[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs in lines (tier 0 only when strict), or -1 when it occurs at none. */
function findTier(o: string[], lines: string[], strict: boolean): number {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier += 1) {
    if (occurrences(o, lines, tier, 0).length > 0) return tier;
  }
  return -1;
}

/** One line of N: ctx >= 0 is a context line, the file's own matched line O[ctx]; -1 is an added line. */
interface NLine {
  text: string;
  ctx: number;
}

/** Map N's lines onto the file at position pos: context lines are the file's own; at tier 2 the rest re-indent. */
function mapN(n: NLine[], o: string[], lines: string[], pos: number, tier: number): string[] {
  const f = tier === 2 ? leadingWs(lines[pos]!) : '';
  const p = tier === 2 ? leadingWs(o[0]!) : '';
  return n.map((l) => {
    if (l.ctx >= 0) return lines[pos + l.ctx]!;
    if (tier !== 2) return l.text;
    const t = l.text;
    if (t === '' || /^[ \t]*$/.test(t)) return t;
    return t.startsWith(p) ? f + t.slice(p.length) : t;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

// ---- Unified diffs (SPEC.md section 6) ----

interface BodyLine {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  raw: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
  o: string[];
  n: NLine[];
  /** a `\` line follows the hunk's last context or `+` line */
  noNl: boolean;
}

function buildHunk(a: number, body: BodyLine[]): Hunk {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      n.push({ text: b.text, ctx: o.length });
      o.push(b.text);
    } else if (b.kind === 'del') o.push(b.text);
    else if (b.kind === 'add') n.push({ text: b.text, ctx: -1 });
  }
  let noNl = false;
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const b = body[i]!;
    if (b.kind === 'ctx' || b.kind === 'add') {
      noNl = i + 1 < body.length && body[i + 1]!.kind === 'bs';
      break;
    }
  }
  return { a, body, o, n, noNl };
}

interface Section {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  gitA: string | undefined;
  gitB: string | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path a `--- `/`+++ ` header line names: after the four characters, to the first tab, spaces trimmed. */
function headerPath(line: string): string | null {
  let t = line.slice(4).split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function unifiedEdits(lines: string[], strict: boolean, moves: { old: string; new: string }[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        oldPath: undefined,
        newPath: undefined,
        gitA: m[1],
        gitB: m[2],
        renameFrom: undefined,
        renameTo: undefined,
        newFile: false,
        deletedFile: false,
        hunks: [],
      };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (cur === null || cur.hunks.length > 0) {
          cur = {
            oldPath: undefined,
            newPath: undefined,
            gitA: undefined,
            gitB: undefined,
            renameFrom: undefined,
            renameTo: undefined,
            newFile: false,
            deletedFile: false,
            hunks: [],
          };
          sections.push(cur);
        }
        cur.oldPath = headerPath(line);
        cur.newPath = headerPath(next);
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ kind: 'ctx', text: '', raw: bl });
          j += 1;
          continue;
        }
        const c = bl[0];
        if (c === ' ') {
          body.push({ kind: 'ctx', text: bl.slice(1), raw: bl });
          j += 1;
          continue;
        }
        if (c === '-') {
          body.push({ kind: 'del', text: bl.slice(1), raw: bl });
          j += 1;
          continue;
        }
        if (c === '+') {
          body.push({ kind: 'add', text: bl.slice(1), raw: bl });
          j += 1;
          continue;
        }
        if (c === '\\') {
          body.push({ kind: 'bs', text: bl.slice(1), raw: bl });
          j += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
      cur.hunks.push(buildHunk(a, body));
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict, moves));
}

/** Apply one hunk to the file's current lines; d is the drift of this section's hunks applied so far. */
function applyHunk(
  state: { lines: string[]; br: string; final: boolean },
  h: Hunk,
  d: number,
  strict: boolean,
  failPath: string,
): { lines: string[]; br: string; final: boolean } {
  const { lines, br, final } = state;
  if (h.o.length > 0) {
    const tier = findTier(h.o, lines, strict);
    if (tier < 0) throw new Fail('no-match', failPath);
    const occs = occurrences(h.o, lines, tier, 0);
    const target = h.a - 1 + d;
    let pos = occs[0]!;
    let best = Math.abs(pos - target);
    for (const o of occs) {
      const dist = Math.abs(o - target);
      if (dist < best) {
        best = dist;
        pos = o;
      }
    }
    const mapped = mapN(h.n, h.o, lines, pos, tier);
    const out = [...lines.slice(0, pos), ...mapped, ...lines.slice(pos + h.o.length)];
    const endsAtEof = pos + h.o.length === lines.length;
    return { lines: out, br, final: endsAtEof ? !h.noNl : final };
  }
  const pos = Math.max(0, Math.min(h.a + d, lines.length));
  const out = [...lines.slice(0, pos), ...h.n.map((l) => l.text), ...lines.slice(pos)];
  return { lines: out, br, final: pos === lines.length ? !h.noNl : final };
}

function sectionEdit(sec: Section, strict: boolean, moves: { old: string; new: string }[]): Edit {
  const oldPath = sec.oldPath !== undefined ? sec.oldPath : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitA;
  const newPath = sec.newPath !== undefined ? sec.newPath : sec.renameTo !== undefined ? sec.renameTo : sec.gitB;
  if (oldPath === null && newPath === null) return () => undefined;
  if (oldPath === undefined || newPath === undefined) return () => undefined;
  if ((oldPath === null || sec.newFile) && newPath !== null) {
    const target = newPath;
    const hunks = sec.hunks;
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus: string[] = [];
      let noFinal = false;
      for (const h of hunks) {
        for (let k = 0; k < h.body.length; k += 1) {
          if (h.body[k]!.kind === 'add') {
            plus.push(h.body[k]!.text);
            noFinal = k + 1 < h.body.length && h.body[k + 1]!.kind === 'bs';
          }
        }
      }
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (noFinal ? '' : '\n'));
    };
  }
  if ((newPath === null || sec.deletedFile) && oldPath !== null) {
    const target = oldPath;
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
    };
  }
  if (oldPath === null || newPath === null) return () => undefined;
  const from: string = oldPath;
  const to: string = newPath;
  const isMove = from !== to;
  const hunks = sec.hunks;
  return (tree) => {
    if (!safe(from)) throw new Fail('unsafe', from);
    if (isMove && !safe(to)) throw new Fail('unsafe', to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (isMove && tree.get(to) !== null) throw new Fail('exists', to);
    let state = splitFile(before);
    let d = 0;
    for (const h of hunks) {
      state = applyHunk(state, h, d, strict, from);
      d += h.n.length - h.o.length;
    }
    const out = joinFile(state.lines, state.br, state.final);
    if (isMove) {
      tree.now.set(from, null);
      tree.now.set(to, out);
      moves.push({ old: from, new: to });
    } else {
      tree.now.set(from, out);
    }
  };
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | undefined = undefined;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let eqIdx = -1;
    let repIdx = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (eqIdx < 0 && lines[j]!.trimEnd() === '=======') {
        eqIdx = j;
        continue;
      }
      if (eqIdx >= 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        repIdx = j;
        break;
      }
    }
    if (eqIdx < 0 || repIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | undefined = undefined;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === undefined) {
      if (prevPath === undefined) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    prevPath = path;
    prevEnd = repIdx;
    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    edits.push(srEdit(path, oldLines, newLines, strict));
    i = repIdx + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const state = splitFile(before);
    const tier = findTier(oldLines, state.lines, strict);
    if (tier < 0) throw new Fail('no-match', path);
    const occs = occurrences(oldLines, state.lines, tier, 0);
    if (occs.length > 1) throw new Fail('ambiguous', path);
    const pos = occs[0]!;
    const n: NLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    const out = [...state.lines.slice(0, pos), ...mapN(n, oldLines, state.lines, pos, tier), ...state.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile(out, state.br, state.final));
  };
}

// ---- V4A patches (SPEC.md section 8) ----

function isV4aSectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

interface V4aChunk {
  anchor: string | null;
  o: string[];
  n: NLine[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean, moves: { old: string; new: string }[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const sec: { text: string; idx: number }[] = [];
      let j = i + 1;
      while (j < last && !isV4aSectionStart(lines[j]!)) {
        sec.push({ text: lines[j]!, idx: j });
        j += 1;
      }
      while (sec.length > 0 && blank(sec[sec.length - 1]!.text)) sec.pop();
      const content: string[] = [];
      for (const sl of sec) {
        if (sl.text.startsWith('+')) content.push(sl.text.slice(1));
        else if (sl.text === '') content.push('');
        else throw new Exit2(`error: parse ${sl.idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
      });
      i = j;
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last && !isV4aSectionStart(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i = j;
    } else if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateIdx = i;
      const sec: { text: string; idx: number }[] = [];
      let j = i + 1;
      while (j < last && !isV4aSectionStart(lines[j]!)) {
        sec.push({ text: lines[j]!, idx: j });
        j += 1;
      }
      while (sec.length > 0 && blank(sec[sec.length - 1]!.text)) sec.pop();
      edits.push(v4aUpdateEdit(path, sec, updateIdx, strict, moves));
      i = j;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return edits;
}

/** The first line at or after the cursor equal to the anchor, at the first tier where one is, or -1. */
function findAnchor(anchor: string, lines: string[], cursor: number, strict: boolean): number {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier += 1) {
    const key = lineKey(anchor, tier);
    for (let i = cursor; i < lines.length; i += 1) {
      if (lineKey(lines[i]!, tier) === key) return i;
    }
  }
  return -1;
}

/** The chunk's occurrence: first at or after the cursor at the first tier with one; an end-of-file chunk only takes one ending at the file's last line. */
function findChunkOccurrence(
  ch: V4aChunk,
  lines: string[],
  cursor: number,
  strict: boolean,
): { pos: number; tier: number } | null {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier += 1) {
    const occs = occurrences(ch.o, lines, tier, cursor);
    for (const pos of occs) {
      if (!ch.eof || pos + ch.o.length === lines.length) return { pos, tier };
    }
  }
  return null;
}

function v4aUpdateEdit(
  path: string,
  sec: { text: string; idx: number }[],
  updateIdx: number,
  strict: boolean,
  moves: { old: string; new: string }[],
): Edit {
  let k = 0;
  let moveTo: string | undefined = undefined;
  if (sec.length > 0 && sec[0]!.text.startsWith('*** Move to: ')) {
    moveTo = sec[0]!.text.slice('*** Move to: '.length).trim();
    k = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: { anchor: string | null; body: BodyLine[] } | null = null;
  let sawChunk = false;
  const closeChunk = (eof: boolean): void => {
    if (cur === null) return;
    const o: string[] = [];
    const n: NLine[] = [];
    for (const b of cur.body) {
      if (b.kind === 'ctx') {
        n.push({ text: b.text, ctx: o.length });
        o.push(b.text);
      } else if (b.kind === 'del') o.push(b.text);
      else if (b.kind === 'add') n.push({ text: b.text, ctx: -1 });
    }
    chunks.push({ anchor: cur.anchor, o, n, eof });
    cur = null;
    sawChunk = true;
  };
  for (; k < sec.length; k += 1) {
    const { text, idx } = sec[k]!;
    if (text.startsWith('@@')) {
      closeChunk(false);
      const anchor = text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [] };
    } else if (text === '*** End of File') {
      closeChunk(true);
    } else if (text.startsWith(' ') || text.startsWith('-') || text.startsWith('+') || text === '') {
      if (cur === null) {
        if (sawChunk) throw new Exit2(`error: parse ${idx + 1}`);
        cur = { anchor: null, body: [] };
      }
      if (text === '') cur.body.push({ kind: 'ctx', text: '', raw: text });
      else if (text[0] === ' ') cur.body.push({ kind: 'ctx', text: text.slice(1), raw: text });
      else if (text[0] === '-') cur.body.push({ kind: 'del', text: text.slice(1), raw: text });
      else cur.body.push({ kind: 'add', text: text.slice(1), raw: text });
    } else {
      throw new Exit2(`error: parse ${idx + 1}`);
    }
  }
  closeChunk(false);
  if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${updateIdx + 1}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let state = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(ch.anchor, state.lines, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (ch.o.length > 0) {
        const found = findChunkOccurrence(ch, state.lines, cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        const mapped = mapN(ch.n, ch.o, state.lines, found.pos, found.tier);
        state = {
          ...state,
          lines: [...state.lines.slice(0, found.pos), ...mapped, ...state.lines.slice(found.pos + ch.o.length)],
        };
        cursor = found.pos + mapped.length;
      } else {
        const pos = ch.eof ? state.lines.length : cursor;
        const mapped = ch.n.map((l) => l.text);
        state = { ...state, lines: [...state.lines.slice(0, pos), ...mapped, ...state.lines.slice(pos)] };
        cursor = pos + mapped.length;
      }
    }
    const out = joinFile(state.lines, state.br, state.final);
    if (moveTo !== undefined) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

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
  const moves: { old: string; new: string }[] = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, moves)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rows: { key: string; line: string }[] = [];
  const paired = new Set<string>();
  for (const m of moves) {
    const o = changed.get(m.old);
    const n = changed.get(m.new);
    if (o !== undefined && o.was !== null && o.now === null && n !== undefined && n.was === null && n.now !== null) {
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      paired.add(m.old);
      paired.add(m.new);
    }
  }
  for (const [p, s] of changed) {
    if (paired.has(p)) continue;
    rows.push({ key: p, line: `${s.was === null ? 'A' : s.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const [p, s] of changed) if (s.now === null) rmSync(p, { force: true });
    for (const [p, s] of changed) {
      if (s.now !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, s.now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
