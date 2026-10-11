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
const CLOSERS = new Set(['sinon', 'fsi', 'ftq', 'fpour', 'jusqua', 'fcas', 'fin', 'ffonction']);
const CMP = new Set(['=', '==', '!=', '<>', '<', '>', '<=', '>=']);

class Parser {
  constructor(toks, lang) { this.t = toks; this.p = 0; this.lang = lang; this.sub = null; this.subs = []; }
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
  // [sous-programmes] [action NOM] {const|var|type|sous-programme|instruction} debut ... fin [sous-programmes]
  isSubStart() { return this.isKw('fonction') || this.isKw('procedure'); }
  parseProgram() {
    let name = 'programme';
    while (this.isSubStart()) this.subs.push(this.parseSubprogram());
    if (this.acceptKw('programme') && this.isIdent(this.cur)) name = this.next().raw;
    if (this.isOp('(')) { this.next(); this.acceptOp(')'); }
    const decls = [], pre = [];
    while (!this.isKw('debut')) {
      const t = this.cur;
      if (t.type === 'eof') {
        if (this.subs.length) this.fail("il manque le programme principal (« debut ... fin ») qui appelle tes fonctions et procédures", t);
        this.fail("il manque le mot « debut » pour commencer le programme", t);
      }
      if (this.isSubStart()) this.subs.push(this.parseSubprogram());
      else if (this.isKw('const') || (this.isKw('var') && this.isKw('const', 1))) decls.push(...this.parseConst());
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
    while (this.isSubStart()) this.subs.push(this.parseSubprogram());
    if (this.cur.type !== 'eof') this.fail(`il y a encore du texte après le « fin » du programme (${this.show(this.cur)})`);
    const ast = { name, decls, pre, body, subs: this.subs };
    checkProgram(ast, this.lang);
    return ast;
  }

  // fonction nom(a : entier, b : entier; var c : reel) : type   |   procedure nom(...)
  // puis {const|var|type} debut ... fin [fin fonction]
  parseSubprogram() {
    const kwTok = this.next(), kind = kwTok.kw, line = kwTok.line;
    const what = kind === 'fonction' ? 'la fonction' : 'la procédure';
    const id = this.expectIdent(`le nom de ${what}`);
    if (this.lang.funcs.has(id.norm))
      this.fail(`« ${id.raw} » est déjà le nom d'une fonction intégrée : choisis un autre nom pour ${what}`, id);
    const dup = this.subs.find((x) => x.norm === id.norm);
    if (dup) this.fail(`il y a déjà une fonction ou procédure nommée « ${id.raw} » (ligne ${dup.line}) : chaque sous-programme doit avoir un nom différent`, id);
    const params = [];
    if (this.acceptOp('(')) {
      if (!this.isOp(')')) {
        do {
          const mode = this.acceptKw('var') ? 'var' : 'valeur';
          const names = [this.expectIdent("le nom d'un paramètre")];
          while (this.isOp(',') && this.isIdent(this.peek(1))) { this.next(); names.push(this.next()); }
          if (!this.isOp(':'))
            this.fail(`il manque le type du paramètre « ${names[names.length - 1].raw} » (exemple : ${names[names.length - 1].raw} : entier)`);
          this.next();
          const type = this.parseType(true);
          for (const n of names) {
            if (params.some((q) => q.norm === n.norm)) this.fail(`le paramètre « ${n.raw} » apparaît deux fois`, n);
            params.push({ name: n.raw, norm: n.norm, type, mode, line: n.line });
          }
        } while (this.acceptOp(',') || this.acceptOp(';'));
      }
      if (!this.isOp(')'))
        this.fail(`dans la liste des paramètres de « ${id.raw} », j'attendais « , » ou « ) » mais j'ai trouvé ${this.show(this.cur)}`);
      this.next();
    }
    let ret = null;
    if (kind === 'fonction') {
      if (!this.acceptOp(':'))
        this.fail(`il manque le type de la valeur retournée par la fonction « ${id.raw} » (exemple : fonction ${id.raw}(x : entier) : entier)`, this.cur, id.line);
      ret = this.parseType();
    } else if (this.isOp(':') && this.cur.line === id.line) {
      this.fail(`une procédure ne retourne pas de valeur : si « ${id.raw} » doit renvoyer un résultat, écris « fonction » au lieu de « procedure »`);
    }
    const sub = { kind, name: id.raw, norm: id.norm, params, ret, decls: [], body: null, line };
    const decls = sub.decls;
    while (!this.isKw('debut')) {
      const t = this.cur;
      if (this.isKw('const') || (this.isKw('var') && this.isKw('const', 1))) decls.push(...this.parseConst());
      else if (this.isKw('var')) { this.next(); decls.push(...this.parseVarList()); }
      else if (this.isKw('type')) decls.push(this.parseTypeDecl());
      else if (this.bareDecl()) decls.push(...this.parseVarList());
      else if (this.isSubStart())
        this.fail(`il manque « debut ... fin » pour ${what} « ${id.raw} » avant de commencer un autre sous-programme`, t);
      else this.fail(`j'attendais « debut » pour commencer ${what} « ${id.raw} » (déclare d'abord ses variables avec « var ») mais j'ai trouvé ${this.show(t)}`, t);
      while (this.acceptOp(';'));
    }
    this.next();
    const outer = this.sub;
    this.sub = sub;
    sub.body = this.parseBlock();
    this.sub = outer;
    sub.endLine = this.cur.line;
    if (this.isKw('fin')) { this.next(); this.acceptKw('ffonction'); }
    else if (this.isKw('ffonction')) this.next();
    else this.expectClose('fin', 'fin', line, `${kind} ${id.raw}`);
    return sub;
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

  parseType(param = false) {
    const t = this.cur;
    if (this.isKw('tableau')) {
      this.next();
      const dims = [];
      if (!this.isOp('[')) {
        if (param) this.fail("pour un paramètre tableau, déclare d'abord un type avant le programme (type vecteur = tableau[1..10] de entier) puis écris « tab : vecteur »");
        this.fail("après « tableau » j'attendais les bornes entre crochets, par exemple tableau[1..10]");
      }
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
        case 'retourner': return this.parseReturn();
        case 'fonction': case 'procedure':
          this.fail(`les fonctions et procédures s'écrivent avant le « debut » du programme principal (pas au milieu des instructions)`);
        default: break;
      }
      if (this.isIdent(t)) return this.parseAssign();
      this.fail(`${this.show(t)} est inattendu ici (il ne correspond à aucun bloc ouvert)`);
    }
    this.fail(`je ne comprends pas ${this.show(t)} ici`);
  }

  parseReturn() {
    const line = this.next().line;
    const sub = this.sub;
    if (!sub) this.fail("« retourner » ne peut s'utiliser que dans une fonction (ici on est dans le programme principal)", this.cur, line);
    const hasExpr = this.startsExpr(this.cur) && this.cur.line === line;
    if (sub.kind === 'procedure') {
      if (hasExpr) this.fail(`« ${sub.name} » est une procédure : elle ne retourne pas de valeur (pour renvoyer un résultat, fais-en une fonction ou utilise un paramètre « var »)`, this.cur, line);
      return { k: 'return', expr: null, line };
    }
    if (!hasExpr) this.fail(`il faut indiquer la valeur à retourner, par exemple « retourner(resultat) »`, this.cur, line);
    return { k: 'return', expr: this.parseExpr(), line };
  }

  parseArgs() {
    this.expectOp('(');
    const args = [];
    if (!this.isOp(')')) do { args.push(this.parseExpr()); } while (this.acceptOp(','));
    if (!this.isOp(')')) this.fail(`dans l'appel, j'attendais « , » ou « ) » mais j'ai trouvé ${this.show(this.cur)} (virgule oubliée entre deux paramètres ?)`);
    this.next();
    return args;
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
    if (targets.length === 1 && targets[0].k === 'var' && op.type === 'op' && op.value === '(')
      return { k: 'callstmt', name: targets[0].name, norm: targets[0].norm, args: this.parseArgs(), line };
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
        this.next();
        if (fn) return { k: 'call', fn, args: this.parseArgs(), line };
        return { k: 'ucall', name: t.raw, norm: t.norm, args: this.parseArgs(), line };   // fonction écrite par l'étudiant (vérifiée par checkProgram)
      }
      const lv = this.parseLvalue();
      return lv;
    }
    this.fail(`j'attendais une valeur, une variable ou une expression mais j'ai trouvé ${this.show(t)}`);
  }
}

// ---------------------------------------------------------------------
//  Vérifications après l'analyse (avant d'exécuter quoi que ce soit)
// ---------------------------------------------------------------------
// Parcourt l'arbre ; appelle f sur chaque nœud qui a un « k ». Marque n.u = true sur les nœuds qui
// contiennent un appel de fonction de l'étudiant (« ucall ») : ces expressions-là sont évaluées par
// Interpreter.evg, qui sait laisser la fonction faire « entrer ». Les autres gardent le chemin rapide ev.
function walk(n, f) {
  if (Array.isArray(n)) { let u = false; for (const x of n) if (walk(x, f)) u = true; return u; }
  if (!n || typeof n !== 'object') return false;
  let u = n.k === 'ucall';
  for (const key in n) { const v = n[key]; if (v && typeof v === 'object' && walk(v, f)) u = true; }
  if (n.k) { if (u) n.u = true; f(n); }
  return u;
}

const nbParams = (n) => (n === 0 ? 'aucun paramètre' : `${n} paramètre${n > 1 ? 's' : ''}`);

function checkProgram(ast, lang) {
  const subs = new Map(ast.subs.map((x) => [x.norm, x]));
  const errs = [];
  for (const sub of ast.subs) {
    if (sub.kind !== 'fonction') continue;
    let has = false;
    walk(sub.body, (n) => { if (n.k === 'return') has = true; });
    if (!has) errs.push([sub.line, `la fonction « ${sub.name} » ne contient aucun « retourner » : une fonction doit renvoyer sa valeur avec retourner(...)`]);
  }
  walk(ast, (n) => {
    switch (n.k) {
      case 'assign': n.uu = !!n.expr.u; break;
      case 'out': n.uu = n.args.some((a) => a.u); break;
      case 'if': n.uu = n.clauses.some((c) => c.cond.u); break;
      case 'while': case 'repeat': n.uu = !!n.cond.u; break;
      case 'for': n.uu = !!(n.from.u || n.to.u || (n.step && n.step.u)); break;
      case 'case': n.uu = !!(n.subject.u || n.branches.some((b) => b.vals.some((v) => v.u))); break;
      default: break;
    }
    if (n.k !== 'ucall' && n.k !== 'callstmt') return;
    const sub = subs.get(n.norm);
    if (!sub) {
      if (n.k === 'callstmt' && lang.funcs.has(n.norm))
        errs.push([n.line, `« ${n.name} » est une fonction intégrée : utilise son résultat, par exemple x <- ${n.name}(...)`]);
      else if (n.k === 'ucall')
        errs.push([n.line, `la fonction « ${n.name} » n'existe pas : ce n'est ni une fonction intégrée (${[...new Set(lang.funcs.values())].join(', ')}), ni une fonction écrite dans ton programme`]);
      else errs.push([n.line, `la procédure « ${n.name} » n'existe pas (faute de frappe ? ou elle n'est pas écrite dans ton programme)`]);
      return;
    }
    const what = sub.kind === 'fonction' ? 'la fonction' : 'la procédure';
    if (n.k === 'ucall' && sub.kind === 'procedure')
      errs.push([n.line, `« ${sub.name} » est une procédure : elle ne retourne pas de valeur, on ne peut pas l'utiliser dans un calcul, une condition ou un sortir(...)`]);
    if (n.args.length !== sub.params.length)
      errs.push([n.line, `${what} « ${sub.name} » attend ${nbParams(sub.params.length)}, tu en donnes ${n.args.length}`]);
    else sub.params.forEach((p, i) => {
      const a = n.args[i];
      if (p.mode === 'var' && a.k !== 'var' && a.k !== 'idx')
        errs.push([n.line, `le paramètre n°${i + 1} de « ${sub.name} » (« ${p.name} ») est passé par variable (var) : il faut lui donner une variable, pas une valeur ou un calcul`]);
    });
  });
  if (errs.length) {
    errs.sort((a, b) => a[0] - b[0]);
    throw new PseudoError(errs[0][1], errs[0][0]);
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
const TYPE_NAMES = { entier: 'un entier', reel: 'un réel', booleen: 'un booléen', caractere: 'un caractère', chaine: 'un texte' };
const typeName = (t) => TYPE_NAMES[t] || t;
// la valeur x peut-elle aller dans une variable de type t ? (les décimaux vers entier sont tronqués par coerce)
const fits = (x, t) =>
  t === 'entier' || t === 'reel' ? typeof x === 'number'
    : t === 'booleen' ? typeof x === 'boolean'
      : t === 'caractere' || t === 'chaine' ? typeof x === 'string' : true;
const sameBase = (a, b) => a === 'auto' || b === 'auto' || a === b ||
  ((a === 'caractere' || a === 'chaine') && (b === 'caractere' || b === 'chaine'));
// « retourner » : signal interne capturé par callUser (pas une Error : pas de pile à construire)
class ReturnSignal { constructor(v, line) { this.v = v; this.line = line; } }
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
    this.o = { sortirRetourLigne: false, strict: false, maxInstructions: 3_000_000, maxAppels: 200, ...lang.options, ...opts };
    // vars = portée globale (programme principal) ; local = portée du sous-programme en cours (null dans le principal)
    this.vars = new Map(); this.local = null; this.types = new Map(); this.warned = new Set();
    this.subs = new Map((ast.subs || []).map((x) => [x.norm, x]));
    this.depth = 0; this.steps = 0; this.stopped = false;
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
    if ((this.local || this.vars).has(d.norm))
      throw this.err(`« ${d.name} » est déjà déclarée${this.local ? " (c'est déjà un paramètre ou une variable locale)" : ''}`, d.line);
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
    (this.local || this.vars).set(norm, v);
    return v;
  }

  // ----- accès aux variables -----
  // une variable locale (ou un paramètre) masque la variable globale de même nom
  lookup(norm) { return (this.local && this.local.get(norm)) || this.vars.get(norm); }
  getVar(node) {
    const v = this.lookup(node.norm);
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
  offset(v, node, iv) {
    if (node.idx.length !== v.dims.length)
      throw this.err(`« ${v.name} » a ${v.dims.length} dimension(s) mais tu donnes ${node.idx.length} indice(s)`, node.line);
    let off = 0;
    for (let k = 0; k < v.dims.length; k++) {
      const x = iv ? iv[k] : this.ev(node.idx[k]), d = v.dims[k];
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
      const v = this.lookup(target.norm) || this.autoVar(target, line);
      if (v.isConst) throw this.err(`« ${v.name} » est une constante : on ne peut pas la modifier`, line);
      if (v.kind === 'array') throw this.err(`« ${v.name} » est un tableau : écris ${v.name}[i] <- ... pour modifier une case`, line);
      v.value = this.coerce(val, v.type, v.name, line);
    } else {
      const v = this.arrVar(target);
      if (v.byValue) this.warn('byval:' + v.norm, `« ${v.name} » est un paramètre tableau passé par valeur : tes modifications resteront dans la procédure (écris « var ${v.name} : ... » dans l'entête pour modifier le tableau de l'appelant)`, line);
      v.data[this.offset(v, target)] = this.coerce(val, v.type, `${v.name}[...]`, line);
    }
  }

  autoVar(target, line) {
    if (this.o.strict) throw this.err(`la variable « ${target.name} » n'est pas déclarée`, line);
    this.warn('undecl:' + target.norm, `la variable « ${target.name} » n'est pas déclarée (je la crée quand même — ajoute « var ${target.name} : entier » avant « debut »)`, line);
    return this.newVar(target.name, target.norm, { kind: 'base', name: 'auto' });
  }

  // ----- expressions -----
  ev(n) {
    switch (n.k) {
      case 'num': case 'str': case 'bool': return n.v;
      case 'var': return this.getScalar(n);
      case 'idx': return this.readCell(this.arrVar(n), n);
      case 'neg': return this.negate(this.ev(n.e), n.line);
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
      case 'call': return this.call(n, n.args.map((x) => this.ev(x)));
      case 'ucall': return this.callSync(n);
      default: throw this.err('expression inconnue', n.line);
    }
  }
  // Version « générateur » de ev, utilisée seulement pour les expressions qui contiennent un appel
  // de fonction de l'étudiant (n.u) : le corps de la fonction peut faire « entrer » (yield).
  *evg(n) {
    if (!n.u) return this.ev(n);
    switch (n.k) {
      case 'ucall': return yield* this.callUser(n);
      case 'idx': {
        const v = this.arrVar(n), iv = [];
        for (const e of n.idx) iv.push(yield* this.evg(e));
        return this.readCell(v, n, iv);
      }
      case 'neg': return this.negate(yield* this.evg(n.e), n.line);
      case 'not': return !this.bool(yield* this.evg(n.e), n.line, 'non');
      case 'bin': {
        if (n.op === 'et' || n.op === 'ou') {
          const a = this.bool(yield* this.evg(n.l), n.line, n.op);
          if (n.op === 'et' && !a) return false;
          if (n.op === 'ou' && a) return true;
          return this.bool(yield* this.evg(n.r), n.line, n.op);
        }
        const a = yield* this.evg(n.l);
        return this.binop(n.op, a, yield* this.evg(n.r), n.line);
      }
      case 'call': {
        const a = [];
        for (const x of n.args) a.push(yield* this.evg(x));
        return this.call(n, a);
      }
      default: return this.ev(n);
    }
  }
  readCell(v, n, iv) {
    let x = v.data[this.offset(v, n, iv)];
    if (x === undefined) {
      if (this.o.strict) throw this.err(`une case de « ${v.name} » n'a pas encore de valeur : remplis le tableau avant de le lire`, n.line);
      this.warn('init:' + v.norm, `une case de « ${v.name} » est lue avant d'avoir reçu une valeur (je prends ${shown(defaultOf(v.type))})`, n.line);
      x = defaultOf(v.type);
    }
    return x;
  }
  negate(x, line) {
    if (typeof x !== 'number') throw this.err(`le signe « - » ne s'applique qu'à un nombre (j'ai ${describe(x)})`, line);
    return -x;
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
  call(n, a) {
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
  cond(n, line) { return this.checkCond(this.ev(n), line); }
  checkCond(x, line) {
    if (typeof x !== 'boolean')
      throw this.err(`la condition doit donner VRAI ou FAUX mais elle donne ${describe(x)} (il manque peut-être une comparaison, par exemple « x mod 5 = 0 »)`, line);
    return x;
  }

  // ----- sous-programmes (fonctions et procédures de l'étudiant) -----
  // Appel : les paramètres sont évalués dans la portée de l'appelant, puis le corps s'exécute dans une
  // nouvelle portée locale. Paramètre par valeur = copie ; paramètre « var » = lien vers la variable
  // (ou la case de tableau) de l'appelant. Renvoie la valeur retournée (fonction) ou undefined (procédure).
  *callUser(n) {
    const sub = this.subs.get(n.norm);
    const bound = [];
    for (let i = 0; i < sub.params.length; i++) {
      const p = sub.params[i], a = n.args[i], t = this.resolveType(p.type);
      const where = `le paramètre n°${i + 1} de « ${sub.name} » (« ${p.name} »)`;
      if (p.mode === 'var') bound.push(yield* this.bindRef(p, t, a, where, n.line));
      else if (t.kind === 'array') bound.push(this.bindArrayCopy(p, t, a, where, n.line, sub));
      else {
        const x = a.u ? yield* this.evg(a) : this.ev(a);
        if (!fits(x, t.name)) throw this.err(`${where} doit être ${typeName(t.name)} mais tu lui donnes ${describe(x)}`, n.line);
        bound.push({ name: p.name, norm: p.norm, kind: 'scalar', type: t.name, value: this.coerce(x, t.name, p.name, n.line) });
      }
    }
    this.callLine = n.line;
    if (this.depth >= this.o.maxAppels)
      throw this.err(`trop d'appels imbriqués (plus de ${this.o.maxAppels}) : récursion infinie ? Vérifie que « ${sub.name} » finit par s'arrêter sans se rappeler.`, n.line);
    const saved = this.local;
    this.local = new Map(bound.map((v) => [v.norm, v]));
    this.depth++;
    try {
      for (const d of sub.decls) this.declare(d);
      try {
        yield* this.execBlock(sub.body);
      } catch (e) {
        if (!(e instanceof ReturnSignal)) throw e;
        if (sub.kind === 'procedure') return undefined;
        const rt = this.resolveType(sub.ret);
        if (rt.kind === 'array')
          throw this.err(`une fonction ne peut pas retourner un tableau : utilise plutôt une procédure avec un paramètre « var »`, e.line);
        if (!fits(e.v, rt.name))
          throw this.err(`la fonction « ${sub.name} » doit retourner ${typeName(rt.name)} mais elle retourne ${describe(e.v)}`, e.line);
        return this.coerce(e.v, rt.name, sub.name, e.line);
      }
      if (sub.kind === 'fonction')
        throw this.err(`la fonction « ${sub.name} » s'est terminée sans « retourner » de valeur (il faut un retourner(...) sur tous les chemins)`, sub.endLine);
      return undefined;
    } finally {
      this.local = saved;
      this.depth--;
    }
  }
  // Appel de fonction depuis un endroit où l'on ne peut pas attendre une saisie
  // (indice de tableau à gauche de <-, borne de tableau, constante...) : exécution synchrone.
  callSync(n) {
    const g = this.callUser(n);
    try {
      for (let r = g.next(); ; r = g.next()) {
        if (r.done) return r.value;
        if (r.value.t === 'read')
          throw this.err(`la fonction « ${n.name} » utilise « entrer » : à cet endroit ce n'est pas possible, range d'abord son résultat dans une variable`, n.line);
      }
    } finally { g.return(); }
  }
  *bindRef(p, t, a, where, line) {
    if (a.k === 'idx') {
      const arr = this.arrVar(a), iv = [];
      for (const e of a.idx) iv.push(e.u ? yield* this.evg(e) : this.ev(e));
      const off = this.offset(arr, a, iv), data = arr.data;
      if (t.kind === 'array') throw this.err(`${where} est un tableau : donne le nom du tableau (« ${arr.name} »), pas une case`, line);
      if (!sameBase(arr.type, t.name)) throw this.err(`${where} doit être ${typeName(t.name)} mais les cases de « ${arr.name} » sont de type ${arr.type}`, line);
      return { name: p.name, norm: p.norm, kind: 'scalar', type: t.name, get value() { return data[off]; }, set value(x) { data[off] = x; } };
    }
    const v = this.lookup(a.norm) || this.autoVar(a, line);
    if (v.isConst) throw this.err(`${where} est passé par variable (var) : on ne peut pas lui donner la constante « ${v.name} »`, line);
    if (t.kind === 'array') {
      if (v.kind !== 'array') throw this.err(`${where} est un tableau mais « ${v.name} » n'est pas un tableau`, line);
      this.sameShape(v, t, where, line);
      return { name: p.name, norm: p.norm, kind: 'array', dims: v.dims, type: v.type, data: v.data };
    }
    if (v.kind === 'array') throw this.err(`« ${v.name} » est un tableau mais ${where} ne l'est pas (donne une case, par exemple ${v.name}[1])`, line);
    if (!sameBase(v.type, t.name)) throw this.err(`${where} doit être ${typeName(t.name)} mais « ${v.name} » est déclarée de type ${v.type}`, line);
    return { name: p.name, norm: p.norm, kind: 'scalar', type: t.name, get value() { return v.value; }, set value(x) { v.value = x; } };
  }
  bindArrayCopy(p, t, a, where, line, sub) {
    const v = a.k === 'var' ? this.getVar(a) : null;
    if (!v || v.kind !== 'array') throw this.err(`${where} est un tableau : donne le nom d'un tableau`, line);
    this.sameShape(v, t, where, line);
    return { name: p.name, norm: p.norm, kind: 'array', dims: v.dims, type: v.type, data: v.data.slice(), byValue: sub.kind === 'procedure' };
  }
  sameShape(v, t, where, line) {
    const size = (dims) => dims.map((d) => `${d.lo}..${d.hi}`).join('][');
    if (v.dims.length !== t.dims.length || v.dims.some((d, k) => d.lo !== t.dims[k].lo || d.hi !== t.dims[k].hi))
      throw this.err(`${where} attend un tableau [${size(t.dims)}] mais « ${v.name} » est un tableau [${size(v.dims)}]`, line);
    if (!sameBase(v.type, t.elem.name))
      throw this.err(`${where} attend un tableau de ${t.elem.name} mais « ${v.name} » contient des ${v.type}`, line);
  }

  // ----- instructions -----
  step(line) {
    if (++this.steps > this.o.maxInstructions)
      throw this.err(`plus de ${this.o.maxInstructions.toLocaleString('fr-FR')} instructions exécutées : boucle infinie ? J'arrête le programme.`, line);
    return (this.steps & 4095) === 0;
  }
  *execBlock(list) { for (const s of list) yield* this.exec(s); }
  // Chemin rapide. Les instructions marquées « uu » (une de leurs expressions appelle une fonction de
  // l'étudiant) et les instructions des sous-programmes passent par execU : garder exec petit compte
  // pour la vitesse (un générateur avec beaucoup de yield* est nettement plus lent dans V8).
  *exec(s) {
    if (this.step(s.line)) { if (this.stopped) throw new StopSignal(); yield { t: 'tick' }; }
    if (s.uu) return yield* this.execU(s);
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
          if (tg.k === 'var') { const v = this.lookup(tg.norm); if (v && v.kind === 'scalar') type = v.type; }
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
        yield* this.loopFor(s, from, to, st);
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
      default: return yield* this.execU(s);
    }
  }
  *loopFor(s, from, to, st) {
    for (const x of [from, to, st])
      if (typeof x !== 'number') throw this.err(`les valeurs d'une boucle pour doivent être des nombres (j'ai ${describe(x)})`, s.line);
    if (st === 0) throw this.err('le pas de la boucle pour ne peut pas être 0', s.line);
    for (let i = from; st > 0 ? i <= to : i >= to; i += st) {
      this.assign(s.v, i, s.line);
      yield* this.execBlock(s.body);
      if (this.step(s.line)) { if (this.stopped) throw new StopSignal(); yield { t: 'tick' }; }
    }
  }
  // Même chose que exec, mais les expressions sont évaluées par evg : une fonction de l'étudiant
  // appelée dans l'expression peut faire « entrer » et rendre la main au navigateur.
  *execU(s) {
    switch (s.k) {
      case 'assign': {
        const v = yield* this.evg(s.expr);
        if (s.eq) this.warn('eq:' + s.line, 'pour ranger une valeur dans une variable on écrit « <- » (le « = » sert à comparer)', s.line);
        this.assign(s.target, v, s.line);
        break;
      }
      case 'out': {
        let txt = '';
        for (const a of s.args) txt += fmt(yield* this.evg(a));
        if (this.o.sortirRetourLigne) txt += '\n';
        this.io.write(txt);
        break;
      }
      case 'if': {
        for (const c of s.clauses) if (this.checkCond(yield* this.evg(c.cond), c.line)) { yield* this.execBlock(c.body); return; }
        if (s.els) yield* this.execBlock(s.els);
        break;
      }
      case 'while':
        while (this.checkCond(yield* this.evg(s.cond), s.line)) {
          yield* this.execBlock(s.body);
          if (this.step(s.line)) { if (this.stopped) throw new StopSignal(); yield { t: 'tick' }; }
        }
        break;
      case 'repeat':
        do {
          yield* this.execBlock(s.body);
          if (this.step(s.line)) { if (this.stopped) throw new StopSignal(); yield { t: 'tick' }; }
        } while (!this.checkCond(yield* this.evg(s.cond), s.line));
        break;
      case 'for': {
        const from = yield* this.evg(s.from), to = yield* this.evg(s.to), st = s.step ? yield* this.evg(s.step) : 1;
        yield* this.loopFor(s, from, to, st);
        break;
      }
      case 'case': {
        const x = yield* this.evg(s.subject);
        for (const b of s.branches) {
          for (const ve of b.vals) {
            const y = yield* this.evg(ve);
            if (typeof y !== typeof x) throw this.err(`on ne peut pas comparer ${describe(x)} avec la valeur ${describe(y)} d'un cas`, s.line);
            if (x === y) { yield* this.execBlock(b.body); return; }
          }
        }
        if (s.def) yield* this.execBlock(s.def);
        break;
      }
      case 'callstmt': {
        const sub = this.subs.get(s.norm);
        if (sub.kind === 'fonction')
          this.warn('unused:' + s.line, `le résultat de la fonction « ${sub.name} » n'est pas utilisé (range-le dans une variable : x <- ${sub.name}(...))`, s.line);
        yield* this.callUser(s);
        break;
      }
      case 'return':
        throw new ReturnSignal(s.expr ? yield* this.evg(s.expr) : undefined, s.line);
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
    // pile JavaScript épuisée (Chrome/Node : RangeError, Firefox : InternalError « too much recursion »)
    if ((e instanceof RangeError && /stack/i.test(e.message)) || (e && e.name === 'InternalError'))
      return { ok: false, error: new PseudoError("trop d'appels imbriqués : récursion trop profonde ou infinie ?", interp.callLine), interp };
    throw e;
  }
}
