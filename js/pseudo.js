// =====================================================================
//  Interpréteur de pseudo-code (français) — fonctionne dans le navigateur
//  ET dans Node (pour les tests). Aucune dépendance.
//
//  Pipeline : texte --lex--> jetons --Parser--> arbre --Interpreter--> résultat
//  Les mots-clés viennent de lang/langage.json (voir makeLang).
// =====================================================================

export const normalise = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export class PseudoError extends Error {
  constructor(msg, line) {
    super(line ? `Ligne ${line} : ${msg}` : msg);
    this.name = 'PseudoError';
    this.line = line || null;
    this.detail = msg;
  }
}
export class StopSignal extends Error {
  constructor() { super('Exécution arrêtée.'); this.name = 'StopSignal'; }
}

// ---------------------------------------------------------------------
//  Langue : transforme langage.json en tables de recherche
// ---------------------------------------------------------------------
export function makeLang(json) {
  const single = new Map();
  const phrases = [];
  for (const [canon, list] of Object.entries(json.motsCles)) {
    for (const alias of list) {
      const words = normalise(alias).trim().split(/\s+/);
      if (words.length > 1) phrases.push({ words, canon });
      else single.set(words[0], canon);
    }
  }
  phrases.sort((a, b) => b.words.length - a.words.length);
  const types = new Map();
  for (const [canon, list] of Object.entries(json.types || {}))
    for (const a of list) types.set(normalise(a), canon);
  const funcs = new Map();
  for (const [canon, list] of Object.entries(json.fonctions || {}))
    for (const a of list) funcs.set(normalise(a), canon);
  return {
    json, single, phrases, types, funcs,
    soft: new Set(json.contextuels || []),
    options: json.options || {},
  };
}

// ---------------------------------------------------------------------
//  Analyse lexicale
// ---------------------------------------------------------------------
const OPS2 = ['<-', ':=', '<=', '>=', '<>', '!=', '==', '+=', '-=', '..'];
const OPS1 = '+-*/%()[],:;=<>';
const ESC = { n: '\n', t: '\t', '\\': '\\', '"': '"', "'": "'" };

export function lex(src, lang) {
  const toks = [];
  let i = 0, line = 1;
  const n = src.length;
  const add = (o) => toks.push({ line, ...o });
  const wordRe = /[\p{L}_][\p{L}\p{N}_]*/uy;
  const numRe = /\d+(?:\.\d+)?/y;

  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '\\') { i++; continue; }                       // échappements Markdown : \[ \* \_
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2; continue;
    }

    // --- texte entre guillemets ---
    if ('"“”\'‘’'.includes(c)) {
      const closers = '"“”'.includes(c) ? '"“”' : '\'‘’';
      let j = i + 1, s = '', closed = false;
      while (j < n && src[j] !== '\n') {
        const d = src[j];
        if (closers.includes(d)) { closed = true; j++; break; }
        if (d === '\\') {
          const e = src[j + 1];
          if (e in ESC) { s += ESC[e]; j += 2; continue; }
          if (e && '*_[]'.includes(e)) { s += e; j += 2; continue; }
        }
        s += d; j++;
      }
      if (!closed) {
        add({ type: 'bad', raw: src.slice(i, j), msg: 'il manque le guillemet fermant de ce texte (les guillemets doivent être fermés sur la même ligne)' });
      } else add({ type: 'str', value: s, raw: src.slice(i, j) });
      i = j; continue;
    }

    // --- nombre ---
    if (c >= '0' && c <= '9') {
      numRe.lastIndex = i;
      const m = numRe.exec(src);
      add({ type: 'num', value: m[0], raw: m[0] });
      i += m[0].length; continue;
    }

    // --- mot ---
    wordRe.lastIndex = i;
    const wm = /^[\p{L}_]/u.test(c) ? wordRe.exec(src) : null;
    if (wm) {
      let raw = wm[0], norm = normalise(raw);
      i += raw.length;
      if (norm === 'jusqu' && (src[i] === "'" || src[i] === '’') && /\p{L}/u.test(src[i + 1] || '')) {
        norm = 'jusqu' + normalise(src[i + 1]);
        raw = raw + src[i] + src[i + 1];
        i += 2;
      }
      add({ type: 'word', raw, norm });
      continue;
    }

    // --- opérateurs ---
    if (c === '!' && /^!\s*=/.test(src.slice(i, i + 8))) {
      add({ type: 'op', value: '!=', raw: '!=' });
      i = src.indexOf('=', i) + 1; continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '&&' || two === '||') { add({ type: 'word', raw: two, norm: two }); i += 2; continue; }
    if (OPS2.includes(two)) { add({ type: 'op', value: two, raw: two }); i += 2; continue; }
    if (c === '←') { add({ type: 'op', value: '<-', raw: c }); i++; continue; }
    if (c === '≠') { add({ type: 'op', value: '!=', raw: c }); i++; continue; }
    if (c === '≤') { add({ type: 'op', value: '<=', raw: c }); i++; continue; }
    if (c === '≥') { add({ type: 'op', value: '>=', raw: c }); i++; continue; }
    if (OPS1.includes(c)) { add({ type: 'op', value: c, raw: c }); i++; continue; }

    add({ type: 'bad', raw: c, msg: `caractère inattendu « ${c} »` });
    i++;
  }

  // --- fusion des mots-clés à plusieurs mots ("tant que", "fin si"...) puis étiquetage ---
  const out = [];
  for (let k = 0; k < toks.length;) {
    const t = toks[k];
    if (t.type === 'word') {
      let merged = false;
      for (const p of lang.phrases) {
        if (t.norm !== p.words[0]) continue;
        let ok = true;
        for (let q = 1; q < p.words.length; q++) {
          const u = toks[k + q];
          if (!u || u.type !== 'word' || u.line !== t.line || u.norm !== p.words[q]) { ok = false; break; }
        }
        if (ok) {
          out.push({ type: 'word', raw: toks.slice(k, k + p.words.length).map((x) => x.raw).join(' '), norm: p.canon, kw: p.canon, line: t.line });
          k += p.words.length; merged = true; break;
        }
      }
      if (merged) continue;
      t.kw = lang.single.get(t.norm) || null;
    }
    out.push(t); k++;
  }
  out.push({ type: 'eof', line, raw: 'la fin du programme' });
  return out;
}

// ---------------------------------------------------------------------
//  Analyse syntaxique
// ---------------------------------------------------------------------
const CLOSERS = new Set(['sinon', 'fsi', 'ftq', 'fpour', 'jusqua', 'fcas', 'fin']);
const CMP = new Set(['=', '==', '!=', '<>', '<', '>', '<=', '>=']);

class Parser {
  constructor(toks, lang) { this.t = toks; this.p = 0; this.lang = lang; }
  get cur() { return this.t[this.p]; }
  peek(o = 0) { return this.t[Math.min(this.p + o, this.t.length - 1)]; }
  next() { const t = this.t[this.p]; if (this.p < this.t.length - 1) this.p++; return t; }
  isKw(c, o = 0) { const t = this.peek(o); return t.type === 'word' && t.kw === c; }
  isOp(v, o = 0) { const t = this.peek(o); return t.type === 'op' && t.value === v; }
  acceptKw(c) { if (this.isKw(c)) { this.next(); return true; } return false; }
  acceptOp(v) { if (this.isOp(v)) { this.next(); return true; } return false; }
  show(t) { return t.type === 'eof' ? t.raw : `« ${t.raw} »`; }
  fail(msg, tok = this.cur, line) {
    if (tok && tok.type === 'bad') throw new PseudoError(tok.msg, tok.line);
    throw new PseudoError(msg, line || (tok && tok.line));
  }
  isIdent(t) { return t.type === 'word' && (!t.kw || this.lang.soft.has(t.kw)); }
  expectOp(v, ctx = '') {
    if (this.isOp(v)) return this.next();
    this.fail(`j'attendais « ${v} »${ctx ? ' ' + ctx : ''} mais j'ai trouvé ${this.show(this.cur)}`);
  }
  expectIdent(what) {
    const t = this.cur;
    if (this.isIdent(t)) return this.next();
    if (t.type === 'word' && t.kw)
      this.fail(`${this.show(t)} est un mot réservé du pseudo-code : il ne peut pas servir de nom (j'attendais ${what})`);
    this.fail(`j'attendais ${what} mais j'ai trouvé ${this.show(t)}`);
  }
  startsExpr(t) {
    if (t.type === 'num' || t.type === 'str') return true;
    if (t.type === 'op') return t.value === '(' || t.value === '-' || t.value === '+';
    if (t.type === 'word') return this.isIdent(t) || ['vrai', 'faux', 'non'].includes(t.kw);
    return false;
  }
  isTypeStart(o = 0) {
    const t = this.peek(o);
    return t.type === 'word' && (t.kw === 'tableau' || this.lang.types.has(t.norm) || this.isIdent(t));
  }

  // ----- programme -----
  parseProgram() {
    let name = 'programme';
    if (this.acceptKw('programme') && this.isIdent(this.cur)) name = this.next().raw;
    if (this.isOp('(')) { this.next(); this.acceptOp(')'); }
    const decls = [], pre = [];
    while (!this.isKw('debut')) {
      const t = this.cur;
      if (t.type === 'eof') this.fail("il manque le mot « debut » pour commencer le programme", t);
      if (this.isKw('const') || (this.isKw('var') && this.isKw('const', 1))) decls.push(...this.parseConst());
      else if (this.isKw('var')) { this.next(); decls.push(...this.parseVarList()); }
      else if (this.isKw('type')) decls.push(this.parseTypeDecl());
      else if (this.bareDecl()) decls.push(...this.parseVarList());
      else pre.push(this.parseStatement());
      while (this.acceptOp(';'));
    }
    const debutTok = this.next();
    const body = this.parseBlock();
    if (!this.isKw('fin')) {
      const t = this.cur;
      if (t.type === 'eof') this.fail("il manque le mot « fin » à la fin du programme", t, debutTok.line);
      this.fail(`${this.show(t)} ne correspond à aucun bloc ouvert (un « ${t.raw} » en trop, ou un bloc mal fermé avant ?)`, t);
    }
    this.next();
    if (this.cur.type !== 'eof') this.fail(`il y a encore du texte après le « fin » du programme (${this.show(this.cur)})`);
    return { name, decls, pre, body };
  }

  bareDecl() {
    let k = 0;
    while (this.isIdent(this.peek(k))) {
      if (this.isOp(':', k + 1)) return true;
      if (this.isOp(',', k + 1)) { k += 2; continue; }
      return false;
    }
    return false;
  }

  parseConst() {
    if (this.acceptKw('const')) this.acceptKw('var'); else { this.next(); this.next(); }
    const out = [];
    do {
      const id = this.expectIdent('le nom de la constante');
      let type = null;
      if (this.isOp(':') && this.isTypeStart(1)) { this.next(); type = this.parseType(); }
      let sep = false;
      if (this.isOp('=') || this.isOp(':') || this.isOp(':=') || this.isOp('<-')) { this.next(); sep = true; }
      let expr = null;
      if (this.startsExpr(this.cur) && (sep || this.cur.line === id.line)) expr = this.parseExpr();
      out.push({ k: 'const', name: id.raw, norm: id.norm, type, expr, line: id.line });
    } while (this.acceptOp(','));
    return out;
  }

  parseVarList() {
    const names = [this.expectIdent('un nom de variable')];
    while (this.acceptOp(',')) names.push(this.expectIdent('un nom de variable'));
    let type = null;
    if (this.acceptOp(':')) type = this.parseType();
    return names.map((id) => ({ k: 'var', name: id.raw, norm: id.norm, type, line: id.line }));
  }

  parseTypeDecl() {
    const line = this.next().line;
    const id = this.expectIdent('le nom du nouveau type');
    if (!this.acceptOp('=') && !this.acceptOp(':')) this.fail(`j'attendais « = » après « type ${id.raw} »`);
    return { k: 'type', name: id.raw, norm: id.norm, type: this.parseType(), line };
  }

  parseType() {
    const t = this.cur;
    if (this.isKw('tableau')) {
      this.next();
      const dims = [];
      if (!this.isOp('[')) this.fail("après « tableau » j'attendais les bornes entre crochets, par exemple tableau[1..10]");
      while (this.isOp('[')) {
        this.next();
        do {
          const lo = this.parseExpr();
          if (this.acceptOp('..')) dims.push({ lo, hi: this.parseExpr() });
          else dims.push({ lo: { k: 'num', v: 1 }, hi: lo });
        } while (this.acceptOp(','));
        this.expectOp(']');
      }
      this.acceptKw('de'); this.acceptKw('type');
      return { k: 'array', dims, elem: this.parseType(), line: t.line };
    }
    if (t.type === 'word') {
      const base = this.lang.types.get(t.norm);
      if (base) { this.next(); return { k: 'base', name: base }; }
      if (this.isIdent(t)) { this.next(); return { k: 'named', name: t.raw, norm: t.norm, line: t.line }; }
    }
    this.fail(`j'attendais un type (entier, reel, booleen, caractere, chaine, tableau...) mais j'ai trouvé ${this.show(t)}`);
  }

  // ----- instructions -----
  parseBlock(inCase = false) {
    const list = [];
    for (;;) {
      while (this.acceptOp(';'));
      const t = this.cur;
      if (t.type === 'eof') break;
      if (t.type === 'word' && CLOSERS.has(t.kw)) break;
      if (inCase && (t.type === 'num' || t.type === 'str' || this.isKw('vrai') || this.isKw('faux') ||
        (this.isOp('-') && this.peek(1).type === 'num'))) break;
      list.push(this.parseStatement());
    }
    return list;
  }

  parseStatement() {
    const t = this.cur, line = t.line;
    if (t.type === 'word') {
      switch (t.kw) {
        case 'si': return this.parseIf();
        case 'tantque': return this.parseWhile();
        case 'pour': return this.parseFor();
        case 'repeter': return this.parseRepeat();
        case 'casde': return this.parseCase();
        case 'sortir': return this.parseOut();
        case 'entrer': return this.parseIn();
        case 'retourligne': this.next(); return { k: 'nl', line };
        default: break;
      }
      if (this.isIdent(t)) return this.parseAssign();
      this.fail(`${this.show(t)} est inattendu ici (il ne correspond à aucun bloc ouvert)`);
    }
    this.fail(`je ne comprends pas ${this.show(t)} ici`);
  }

  parseLvalue() {
    const id = this.expectIdent('un nom de variable');
    if (this.isOp('[')) {
      const idx = [];
      while (this.isOp('[')) {
        this.next();
        do { idx.push(this.parseExpr()); } while (this.acceptOp(','));
        this.expectOp(']');
      }
      return { k: 'idx', name: id.raw, norm: id.norm, idx, line: id.line };
    }
    return { k: 'var', name: id.raw, norm: id.norm, line: id.line };
  }

  parseAssign() {
    const line = this.cur.line;
    const targets = [this.parseLvalue()];
    while (this.isOp(',')) { this.next(); targets.push(this.parseLvalue()); }
    const op = this.cur;
    if (op.type === 'op' && (op.value === '<-' || op.value === ':=')) {
      this.next();
      if (this.isKw('entrer')) return this.parseIn();        // x <- entrer(x)
      if (targets.length > 1) this.fail("à gauche de « <- » il ne peut y avoir qu'une seule variable", op);
      return { k: 'assign', target: targets[0], expr: this.parseExpr(), line };
    }
    if (targets.length === 1 && op.type === 'op' && (op.value === '+=' || op.value === '-=')) {
      this.next();
      const r = this.parseExpr();
      return { k: 'assign', target: targets[0], line, expr: { k: 'bin', op: op.value[0], l: targets[0], r, line } };
    }
    if (targets.length === 1 && op.type === 'op' && op.value === '=') {
      this.next();
      return { k: 'assign', target: targets[0], expr: this.parseExpr(), line, eq: true };
    }
    if (op.type === 'op' && op.value === '(')
      this.fail(`« ${targets[0].name}(...) » : les procédures et fonctions personnalisées ne sont pas encore gérées par ce site`, targets[0]);
    this.fail(`je ne comprends pas « ${targets[0].name} ${op.type === 'eof' ? '' : op.raw} » : ce n'est pas une instruction connue (pour ranger une valeur dans une variable, écris « ${targets[0].name} <- ... »)`, targets[0]);
  }

  parseOut() {
    const line = this.next().line;
    const args = [];
    if (this.acceptOp('(')) {
      if (!this.isOp(')')) do { args.push(this.parseExpr()); } while (this.acceptOp(','));
      if (!this.isOp(')'))
        this.fail(`dans sortir(...), j'attendais « , » ou « ) » mais j'ai trouvé ${this.show(this.cur)} (virgule oubliée entre deux éléments ?)`);
      this.next();
    } else if (this.startsExpr(this.cur) && this.cur.line === line) {
      do { args.push(this.parseExpr()); } while (this.acceptOp(','));
    }
    return { k: 'out', args, line };
  }

  parseIn() {
    const line = this.next().line;
    const targets = [];
    const paren = this.acceptOp('(');
    do { targets.push(this.parseLvalue()); } while (this.acceptOp(','));
    if (paren) this.expectOp(')', 'pour fermer entrer(');
    return { k: 'in', targets, line };
  }

  expectClose(kw, label, openLine, openName) {
    if (this.isKw(kw)) { this.next(); return; }
    this.fail(`le bloc « ${openName} » ouvert ici n'est pas fermé : il manque « ${label} » (j'ai trouvé ${this.show(this.cur)} à la ligne ${this.cur.line})`, this.cur, openLine);
  }

  parseIf() {
    const line = this.next().line;
    const clauses = [];
    let els = null;
    let cond = this.parseExpr();
    this.acceptKw('alors') || this.acceptKw('faire');
    clauses.push({ cond, body: this.parseBlock(), line });
    while (this.isKw('sinon')) {
      const s = this.next();
      if (this.isKw('si') && this.cur.line === s.line) {
        const l2 = this.next().line;
        cond = this.parseExpr();
        this.acceptKw('alors') || this.acceptKw('faire');
        clauses.push({ cond, body: this.parseBlock(), line: l2 });
      } else { els = this.parseBlock(); break; }
    }
    this.expectClose('fsi', 'fsi', line, 'si');
    return { k: 'if', clauses, els, line };
  }

  parseWhile() {
    const line = this.next().line;
    const cond = this.parseExpr();
    this.acceptKw('alors') || this.acceptKw('faire');
    const body = this.parseBlock();
    this.expectClose('ftq', 'ftq', line, 'tant que');
    return { k: 'while', cond, body, line };
  }

  parseFor() {
    const line = this.next().line;
    const v = this.parseLvalue();
    if (!this.acceptKw('allantde'))
      this.fail(`après « pour ${v.name} » j'attendais « allant de » (exemple : pour i allant de 1 a 10 faire)`);
    const from = this.parseExpr();
    if (!this.acceptKw('a'))
      this.fail("j'attendais « a » (ou « à ») entre la valeur de départ et la valeur de fin de la boucle pour");
    const to = this.parseExpr();
    let step = null;
    if (this.isKw('pas')) { this.next(); this.acceptKw('de'); step = this.parseExpr(); }
    this.acceptKw('faire');
    const body = this.parseBlock();
    this.expectClose('fpour', 'fpour', line, 'pour');
    return { k: 'for', v, from, to, step, body, line };
  }

  parseRepeat() {
    const line = this.next().line;
    const body = this.parseBlock();
    if (!this.isKw('jusqua'))
      this.fail(`le bloc « repeter » ouvert ici n'est pas fermé : il manque « jusqu'a condition » (j'ai trouvé ${this.show(this.cur)})`, this.cur, line);
    this.next();
    return { k: 'repeat', body, cond: this.parseExpr(), line };
  }

  parseCase() {
    const line = this.next().line;
    const subject = this.parseExpr();
    this.acceptOp(':');
    const branches = [];
    let def = null;
    for (;;) {
      const t = this.cur;
      if (t.type === 'eof' || this.isKw('fcas') || this.isKw('fin')) break;
      if (this.isKw('sinon')) { this.next(); this.acceptOp(':'); def = this.parseBlock(true); continue; }
      if (t.type === 'num' || t.type === 'str' || this.isKw('vrai') || this.isKw('faux') || this.isOp('-')) {
        const vals = [];
        do { vals.push(this.parseExpr()); } while (this.acceptOp(','));
        this.expectOp(':', 'après la valeur du cas');
        branches.push({ vals, body: this.parseBlock(true) });
        continue;
      }
      this.fail(`dans un « cas de », j'attendais une valeur suivie de « : » mais j'ai trouvé ${this.show(t)}`);
    }
    this.acceptKw('fcas');
    return { k: 'case', subject, branches, def, line };
  }

  // ----- expressions -----
  parseExpr() { return this.parseOr(); }
  parseOr() {
    let l = this.parseAnd();
    while (this.isKw('ou')) { const line = this.next().line; l = { k: 'bin', op: 'ou', l, r: this.parseAnd(), line }; }
    return l;
  }
  parseAnd() {
    let l = this.parseNot();
    while (this.isKw('et')) { const line = this.next().line; l = { k: 'bin', op: 'et', l, r: this.parseNot(), line }; }
    return l;
  }
  parseNot() {
    if (this.isKw('non')) { const line = this.next().line; return { k: 'not', e: this.parseNot(), line }; }
    return this.parseCmp();
  }
  parseCmp() {
    const l = this.parseAdd();
    const t = this.cur;
    if (t.type === 'op' && CMP.has(t.value)) {
      this.next();
      const op = t.value === '==' ? '=' : t.value === '<>' ? '!=' : t.value;
      return { k: 'bin', op, l, r: this.parseAdd(), line: t.line };
    }
    return l;
  }
  parseAdd() {
    let l = this.parseMul();
    while (this.isOp('+') || this.isOp('-')) { const t = this.next(); l = { k: 'bin', op: t.value, l, r: this.parseMul(), line: t.line }; }
    return l;
  }
  parseMul() {
    let l = this.parseUnary();
    for (;;) {
      const t = this.cur;
      let op = null;
      if (t.type === 'op' && (t.value === '*' || t.value === '/' || t.value === '%')) op = t.value === '%' ? 'mod' : t.value;
      else if (this.isKw('div')) op = 'div';
      else if (this.isKw('mod')) op = 'mod';
      if (!op) return l;
      this.next();
      l = { k: 'bin', op, l, r: this.parseUnary(), line: t.line };
    }
  }
  parseUnary() {
    if (this.isOp('-')) { const line = this.next().line; return { k: 'neg', e: this.parseUnary(), line }; }
    if (this.isOp('+')) { this.next(); return this.parseUnary(); }
    return this.parsePrimary();
  }
  parsePrimary() {
    const t = this.cur, line = t.line;
    if (t.type === 'num') { this.next(); return { k: 'num', v: Number(t.value), line }; }
    if (t.type === 'str') { this.next(); return { k: 'str', v: t.value, line }; }
    if (t.type === 'op' && t.value === '(') {
      this.next();
      const e = this.parseExpr();
      if (!this.isOp(')')) this.fail(`il manque une parenthèse fermante « ) » (j'ai trouvé ${this.show(this.cur)})`);
      this.next();
      return e;
    }
    if (t.type === 'word') {
      if (t.kw === 'vrai') { this.next(); return { k: 'bool', v: true, line }; }
      if (t.kw === 'faux') { this.next(); return { k: 'bool', v: false, line }; }
      if (!this.isIdent(t)) this.fail(`j'attendais une valeur ou une variable mais j'ai trouvé ${this.show(t)}`);
      if (this.isOp('(', 1)) {
        const fn = this.lang.funcs.get(t.norm);
        if (!fn) this.fail(`la fonction « ${t.raw} » n'existe pas (fonctions disponibles : ${[...new Set(this.lang.funcs.values())].join(', ')})`);
        this.next(); this.next();
        const args = [];
        if (!this.isOp(')')) do { args.push(this.parseExpr()); } while (this.acceptOp(','));
        this.expectOp(')');
        return { k: 'call', fn, args, line };
      }
      const lv = this.parseLvalue();
      return lv;
    }
    this.fail(`j'attendais une valeur, une variable ou une expression mais j'ai trouvé ${this.show(t)}`);
  }
}

export function parse(src, lang) {
  return new Parser(lex(src, lang), lang).parseProgram();
}

// ---------------------------------------------------------------------
//  Exécution
// ---------------------------------------------------------------------
export function fmt(v) {
  if (typeof v === 'boolean') return v ? 'VRAI' : 'FAUX';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(parseFloat(v.toPrecision(12)));
  return String(v);
}
const describe = (v) =>
  typeof v === 'number' ? `le nombre ${fmt(v)}` : typeof v === 'boolean' ? `le booléen ${fmt(v)}` : `le texte "${v}"`;
const shown = (v) => (v === '' ? 'un texte vide' : fmt(v));
const defaultOf = (t) => (t === 'booleen' ? false : t === 'caractere' || t === 'chaine' ? '' : 0);

function parseInput(raw, type) {
  const s = String(raw).trim();
  switch (type) {
    case 'entier':
      return /^[+-]?\d+$/.test(s) ? { ok: true, v: Number(s) } : { ok: false, msg: `« ${s} » n'est pas un entier, recommence` };
    case 'reel': {
      const x = s.replace(',', '.');
      return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(x) ? { ok: true, v: Number(x) } : { ok: false, msg: `« ${s} » n'est pas un nombre, recommence` };
    }
    case 'booleen': {
      const n = normalise(s);
      if (['vrai', 'v', 'true', 'oui', 'o', 'y', 'yes', '1'].includes(n)) return { ok: true, v: true };
      if (['faux', 'f', 'false', 'non', 'n', 'no', '0'].includes(n)) return { ok: true, v: false };
      return { ok: false, msg: `« ${s} » n'est pas un booléen (tape VRAI/FAUX, oui/non ou y/n), recommence` };
    }
    case 'caractere': return { ok: true, v: s };
    case 'chaine': return { ok: true, v: String(raw) };
    default:
      return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(s.replace(',', '.')) ? { ok: true, v: Number(s.replace(',', '.')) } : { ok: true, v: String(raw) };
  }
}

export class Interpreter {
  /**
   * io = { write(texte), read(label) -> Promise<string>, warn?(texte) }
   * opts = { strict, sortirRetourLigne, maxInstructions }
   */
  constructor(ast, lang, io, opts = {}) {
    this.ast = ast; this.lang = lang; this.io = io;
    this.o = { sortirRetourLigne: false, strict: false, maxInstructions: 3_000_000, ...lang.options, ...opts };
    this.vars = new Map(); this.types = new Map(); this.warned = new Set();
    this.steps = 0; this.stopped = false;
  }
  stop() { this.stopped = true; }
  err(msg, line) { return new PseudoError(msg, line); }
  warn(key, msg, line) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    if (this.io.warn) this.io.warn(line ? `Ligne ${line} : ${msg}` : msg);
  }

  async run() {
    const gen = this.main();
    let r = gen.next();
    while (!r.done) {
      const q = r.value;
      let reply;
      if (q.t === 'tick') await new Promise((res) => setTimeout(res, 0));
      else if (q.t === 'read') reply = await this.io.read(q.label);
      if (this.stopped) throw new StopSignal();
      r = gen.next(reply);
    }
  }

  *main() {
    for (const d of this.ast.decls) this.declare(d);
    for (const s of this.ast.pre) yield* this.exec(s);
    yield* this.execBlock(this.ast.body);
  }

  // ----- déclarations -----
  declare(d) {
    if (d.k === 'type') { this.types.set(d.norm, d.type); return; }
    if (this.vars.has(d.norm)) throw this.err(`« ${d.name} » est déjà déclarée`, d.line);
    if (d.k === 'const') {
      const type = d.type ? this.resolveType(d.type) : { kind: 'base', name: 'auto' };
      const v = this.newVar(d.name, d.norm, type);
      v.isConst = true;
      if (d.expr) v.value = this.coerce(this.ev(d.expr), v.type, d.name, d.line);
      return;
    }
    this.newVar(d.name, d.norm, d.type ? this.resolveType(d.type) : { kind: 'base', name: 'auto' });
  }
  resolveType(tn) {
    if (tn.k === 'base') return { kind: 'base', name: tn.name };
    if (tn.k === 'named') {
      const def = this.types.get(tn.norm);
      if (!def) throw this.err(`le type « ${tn.name} » n'existe pas : déclare-le avant avec « type ${tn.name} = ... »`, tn.line);
      return this.resolveType(def);
    }
    let dims = tn.dims.map((d) => {
      const lo = this.ev(d.lo), hi = this.ev(d.hi);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw this.err('les bornes du tableau doivent être des entiers', tn.line);
      if (hi < lo) throw this.err(`bornes de tableau invalides : ${lo}..${hi}`, tn.line);
      return { lo, hi, size: hi - lo + 1 };
    });
    let elem = this.resolveType(tn.elem);
    if (elem.kind === 'array') { dims = dims.concat(elem.dims); elem = elem.elem; }
    return { kind: 'array', dims, elem };
  }
  newVar(name, norm, t) {
    const v = { name, norm };
    if (t.kind === 'array') {
      v.kind = 'array'; v.dims = t.dims; v.type = t.elem.name;
      v.data = new Array(t.dims.reduce((a, d) => a * d.size, 1));
    } else { v.kind = 'scalar'; v.type = t.name; v.value = undefined; }
    this.vars.set(norm, v);
    return v;
  }

  // ----- accès aux variables -----
  getVar(node) {
    const v = this.vars.get(node.norm);
    if (!v) throw this.err(`la variable « ${node.name} » n'existe pas (faute de frappe ? ou elle n'est pas déclarée)`, node.line);
    return v;
  }
  getScalar(node) {
    const v = this.getVar(node);
    if (v.kind === 'array') throw this.err(`« ${v.name} » est un tableau : précise la case, par exemple ${v.name}[1]`, node.line);
    if (v.value === undefined) {
      if (v.isConst) throw this.err(`la constante « ${v.name} » n'a pas de valeur`, node.line);
      if (this.o.strict) throw this.err(`la variable « ${v.name} » n'a pas de valeur : initialise-la avant de l'utiliser`, node.line);
      this.warn('init:' + v.norm, `« ${v.name} » est utilisée avant d'avoir reçu une valeur (je prends ${shown(defaultOf(v.type))}) — initialise-la avant !`, node.line);
      v.value = defaultOf(v.type);
    }
    return v.value;
  }
  offset(v, node) {
    if (node.idx.length !== v.dims.length)
      throw this.err(`« ${v.name} » a ${v.dims.length} dimension(s) mais tu donnes ${node.idx.length} indice(s)`, node.line);
    let off = 0;
    for (let k = 0; k < v.dims.length; k++) {
      const x = this.ev(node.idx[k]), d = v.dims[k];
      if (typeof x !== 'number' || !Number.isInteger(x))
        throw this.err(`l'indice de « ${v.name} » doit être un entier (j'ai ${describe(x)})`, node.line);
      if (x < d.lo || x > d.hi)
        throw this.err(`indice ${x} en dehors du tableau « ${v.name} » (cases valides : ${d.lo} à ${d.hi}${v.dims.length > 1 ? `, dimension ${k + 1}` : ''})`, node.line);
      off = off * d.size + (x - d.lo);
    }
    return off;
  }
  arrVar(node) {
    const v = this.getVar(node);
    if (v.kind !== 'array') throw this.err(`« ${v.name} » n'est pas un tableau, on ne peut pas écrire ${v.name}[...]`, node.line);
    return v;
  }

  coerce(val, type, name, line) {
    switch (type) {
      case 'entier':
        if (typeof val !== 'number') throw this.err(`« ${name} » est un entier : impossible d'y ranger ${describe(val)}`, line);
        if (!Number.isInteger(val)) {
          this.warn(`trunc:${line}:${name}`, `${fmt(val)} est tronqué en ${Math.trunc(val)} car « ${name} » est de type entier (utilise reel si tu veux garder les décimales)`, line);
          return Math.trunc(val);
        }
        return val;
      case 'reel':
        if (typeof val !== 'number') throw this.err(`« ${name} » est un réel : impossible d'y ranger ${describe(val)}`, line);
        return val;
      case 'booleen':
        if (typeof val !== 'boolean') throw this.err(`« ${name} » est un booléen : impossible d'y ranger ${describe(val)}`, line);
        return val;
      case 'caractere': case 'chaine':
        if (typeof val !== 'string') throw this.err(`« ${name} » est un texte : impossible d'y ranger ${describe(val)}`, line);
        return val;
      default: return val;
    }
  }
  assign(target, val, line) {
    if (target.k === 'var') {
      let v = this.vars.get(target.norm);
      if (!v) {
        if (this.o.strict) throw this.err(`la variable « ${target.name} » n'est pas déclarée`, line);
        this.warn('undecl:' + target.norm, `la variable « ${target.name} » n'est pas déclarée (je la crée quand même — ajoute « var ${target.name} : entier » avant « debut »)`, line);
        v = this.newVar(target.name, target.norm, { kind: 'base', name: 'auto' });
      }
      if (v.isConst) throw this.err(`« ${v.name} » est une constante : on ne peut pas la modifier`, line);
      if (v.kind === 'array') throw this.err(`« ${v.name} » est un tableau : écris ${v.name}[i] <- ... pour modifier une case`, line);
      v.value = this.coerce(val, v.type, v.name, line);
    } else {
      const v = this.arrVar(target);
      v.data[this.offset(v, target)] = this.coerce(val, v.type, `${v.name}[...]`, line);
    }
  }

  // ----- expressions -----
  ev(n) {
    switch (n.k) {
      case 'num': case 'str': case 'bool': return n.v;
      case 'var': return this.getScalar(n);
      case 'idx': {
        const v = this.arrVar(n);
        let x = v.data[this.offset(v, n)];
        if (x === undefined) {
          if (this.o.strict) throw this.err(`une case de « ${v.name} » n'a pas encore de valeur : remplis le tableau avant de le lire`, n.line);
          this.warn('init:' + v.norm, `une case de « ${v.name} » est lue avant d'avoir reçu une valeur (je prends ${shown(defaultOf(v.type))})`, n.line);
          x = defaultOf(v.type);
        }
        return x;
      }
      case 'neg': {
        const x = this.ev(n.e);
        if (typeof x !== 'number') throw this.err(`le signe « - » ne s'applique qu'à un nombre (j'ai ${describe(x)})`, n.line);
        return -x;
      }
      case 'not': return !this.bool(this.ev(n.e), n.line, 'non');
      case 'bin': {
        if (n.op === 'et' || n.op === 'ou') {
          const a = this.bool(this.ev(n.l), n.line, n.op);
          if (n.op === 'et' && !a) return false;
          if (n.op === 'ou' && a) return true;
          return this.bool(this.ev(n.r), n.line, n.op);
        }
        return this.binop(n.op, this.ev(n.l), this.ev(n.r), n.line);
      }
      case 'call': return this.call(n);
      default: throw this.err('expression inconnue', n.line);
    }
  }
  bool(x, line, op) {
    if (typeof x !== 'boolean') throw this.err(`« ${op} » attend des valeurs VRAI/FAUX mais j'ai ${describe(x)}`, line);
    return x;
  }
  binop(op, a, b, line) {
    const bad = () => this.err(`l'opération « ${op === 'mod' ? 'mod' : op} » n'est pas possible entre ${describe(a)} et ${describe(b)}`, line);
    switch (op) {
      case '=': case '!=':
        if (typeof a !== typeof b) throw this.err(`on ne peut pas comparer ${describe(a)} et ${describe(b)}`, line);
        return op === '=' ? a === b : a !== b;
      case '<': case '>': case '<=': case '>=':
        if (typeof a !== typeof b || typeof a === 'boolean') throw this.err(`on ne peut pas comparer ${describe(a)} et ${describe(b)}`, line);
        return op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b;
      case '+':
        if (typeof a === 'number' && typeof b === 'number') return a + b;
        if (typeof a === 'string' && typeof b === 'string') return a + b;
        throw bad();
      default: {
        if (typeof a !== 'number' || typeof b !== 'number') throw bad();
        switch (op) {
          case '-': return a - b;
          case '*': return a * b;
          case '/': if (b === 0) throw this.err('division par zéro', line); return a / b;
          case 'div': if (b === 0) throw this.err('division par zéro', line); return Math.trunc(a / b);
          case 'mod': if (b === 0) throw this.err('modulo par zéro', line); return a % b;
          default: throw bad();
        }
      }
    }
  }
  call(n) {
    const a = n.args.map((x) => this.ev(x));
    const num = (k) => {
      if (typeof a[k] !== 'number') throw this.err(`la fonction « ${n.fn} » attend un nombre (j'ai ${a[k] === undefined ? 'rien' : describe(a[k])})`, n.line);
      return a[k];
    };
    switch (n.fn) {
      case 'racine': if (num(0) < 0) throw this.err('racine d\'un nombre négatif', n.line); return Math.sqrt(a[0]);
      case 'abs': return Math.abs(num(0));
      case 'partie_entiere': return Math.floor(num(0));
      case 'arrondi': return Math.round(num(0));
      case 'min': return Math.min(...a.map((_, k) => num(k)));
      case 'max': return Math.max(...a.map((_, k) => num(k)));
      case 'longueur': if (typeof a[0] !== 'string') throw this.err('« longueur » attend un texte', n.line); return a[0].length;
      case 'aleatoire': { const lo = num(0), hi = num(1); return lo + Math.floor(Math.random() * (hi - lo + 1)); }
      default: throw this.err(`fonction « ${n.fn} » inconnue`, n.line);
    }
  }
  cond(n, line) {
    const x = this.ev(n);
    if (typeof x !== 'boolean')
      throw this.err(`la condition doit donner VRAI ou FAUX mais elle donne ${describe(x)} (il manque peut-être une comparaison, par exemple « x mod 5 = 0 »)`, line);
    return x;
  }

  // ----- instructions -----
  step(line) {
    if (++this.steps > this.o.maxInstructions)
      throw this.err(`plus de ${this.o.maxInstructions.toLocaleString('fr-FR')} instructions exécutées : boucle infinie ? J'arrête le programme.`, line);
    return (this.steps & 4095) === 0;
  }
  *execBlock(list) { for (const s of list) yield* this.exec(s); }
  *exec(s) {
    if (this.step(s.line)) { if (this.stopped) throw new StopSignal(); yield { t: 'tick' }; }
    switch (s.k) {
      case 'assign': {
        const v = this.ev(s.expr);
        if (s.eq) this.warn('eq:' + s.line, 'pour ranger une valeur dans une variable on écrit « <- » (le « = » sert à comparer)', s.line);
        this.assign(s.target, v, s.line);
        break;
      }
      case 'out': {
        let txt = '';
        for (const a of s.args) txt += fmt(this.ev(a));
        if (this.o.sortirRetourLigne) txt += '\n';
        this.io.write(txt);
        break;
      }
      case 'nl': this.io.write('\n'); break;
      case 'in':
        for (const tg of s.targets) {
          let type = 'auto';
          if (tg.k === 'var') { const v = this.vars.get(tg.norm); if (v && v.kind === 'scalar') type = v.type; }
          else type = this.arrVar(tg).type;
          let val;
          for (;;) {
            const raw = yield { t: 'read', label: tg.name };
            if (raw === undefined || raw === null) throw this.err('plus aucune valeur à lire', s.line);
            const r = parseInput(raw, type);
            if (r.ok) { val = r.v; break; }
            if (this.io.warn) this.io.warn('✗ ' + r.msg);
          }
          this.assign(tg, val, s.line);
        }
        break;
      case 'if': {
        for (const c of s.clauses) if (this.cond(c.cond, c.line)) { yield* this.execBlock(c.body); return; }
        if (s.els) yield* this.execBlock(s.els);
        break;
      }
      case 'while':
        while (this.cond(s.cond, s.line)) {
          yield* this.execBlock(s.body);
          if (this.step(s.line)) { if (this.stopped) throw new StopSignal(); yield { t: 'tick' }; }
        }
        break;
      case 'repeat':
        do {
          yield* this.execBlock(s.body);
          if (this.step(s.line)) { if (this.stopped) throw new StopSignal(); yield { t: 'tick' }; }
        } while (!this.cond(s.cond, s.line));
        break;
      case 'for': {
        const from = this.ev(s.from), to = this.ev(s.to), st = s.step ? this.ev(s.step) : 1;
        for (const x of [from, to, st])
          if (typeof x !== 'number') throw this.err(`les valeurs d'une boucle pour doivent être des nombres (j'ai ${describe(x)})`, s.line);
        if (st === 0) throw this.err('le pas de la boucle pour ne peut pas être 0', s.line);
        for (let i = from; st > 0 ? i <= to : i >= to; i += st) {
          this.assign(s.v, i, s.line);
          yield* this.execBlock(s.body);
          if (this.step(s.line)) { if (this.stopped) throw new StopSignal(); yield { t: 'tick' }; }
        }
        break;
      }
      case 'case': {
        const x = this.ev(s.subject);
        for (const b of s.branches) {
          for (const ve of b.vals) {
            const y = this.ev(ve);
            if (typeof y !== typeof x) throw this.err(`on ne peut pas comparer ${describe(x)} avec la valeur ${describe(y)} d'un cas`, s.line);
            if (x === y) { yield* this.execBlock(b.body); return; }
          }
        }
        if (s.def) yield* this.execBlock(s.def);
        break;
      }
      default: throw this.err('instruction inconnue', s.line);
    }
  }
}

// ---------------------------------------------------------------------
//  Raccourci : analyse + exécution. Renvoie { ok, error?, stopped? }
// ---------------------------------------------------------------------
export async function runSource(src, lang, io, opts = {}) {
  let interp;
  try {
    const ast = parse(src, lang);
    interp = new Interpreter(ast, lang, io, opts);
    if (typeof opts.onReady === 'function') opts.onReady(interp);
  } catch (e) {
    if (e instanceof PseudoError) return { ok: false, error: e, interp: null };
    throw e;
  }
  try {
    await interp.run();
    return { ok: true, interp };
  } catch (e) {
    if (e instanceof StopSignal) return { ok: false, stopped: true, interp };
    if (e instanceof PseudoError) return { ok: false, error: e, interp };
    throw e;
  }
}
