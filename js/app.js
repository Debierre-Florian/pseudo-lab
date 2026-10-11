import { makeLang, runSource, normalise, StopSignal } from './pseudo.js';
import { CONFIG } from './config.js';
import { createLocalBackend } from './backend-local.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/** Crée un élément DOM. Les textes passent par createTextNode : jamais d'HTML venu d'un utilisateur. */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'value') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

const pref = {
  get(k, d) { try { const v = localStorage.getItem('pl_' + k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pl_' + k, v); } catch { /* ignoré */ } },
};

const state = {
  lang: null, langJson: null, backend: null, me: null, cm: null,
  modele: '', examples: [], templates: [],
  settings: { run_enabled: true, free_programs: true }, projects: [],
  doc: { id: null, owner: null, author: null, isCopy: false, project: null },
  dirty: false, running: false, interp: null, errLine: null, view: 'editor',
};

/* ===================================================================
   Petits utilitaires d'interface
   =================================================================== */
let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast ' + kind; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'err' ? 5000 : 2200);
}
const fmtDate = (iso) => new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const loadScript = (src) => new Promise((res, rej) => {
  const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Impossible de charger ' + src)); document.head.append(s);
});

/* ===================================================================
   Console (sortie + saisie en ligne comme dans un terminal)
   =================================================================== */
const con = (() => {
  const out = $('#out'), box = $('#console');
  let atStart = true, pending = null;
  const scroll = () => { box.scrollTop = box.scrollHeight; };
  const raw = (txt, cls) => {
    if (!txt) return;
    out.append(h('span', { class: cls }, txt));
    atStart = txt.endsWith('\n');
    scroll();
  };
  const nl = () => { if (!atStart) raw('\n', 'o'); };
  return {
    clear() { out.textContent = ''; atStart = true; },
    write: (t) => raw(t, 'o'),
    warn: (m) => { nl(); raw((m.startsWith('✗') ? '' : '⚠ ') + m + '\n', 'w'); },
    info: (m) => { nl(); raw(m + '\n', 'i'); },
    error: (m) => { nl(); raw('✗ ' + m + '\n', 'e'); },
    nl,
    read(label) {
      return new Promise((resolve, reject) => {
        const inp = h('input', { class: 'con-input', type: 'text', placeholder: label, 'aria-label': 'Valeur pour ' + label, autocomplete: 'off', spellcheck: 'false' });
        out.append(inp); scroll(); inp.focus();
        const fit = () => { inp.style.width = Math.max(10, inp.value.length + 2) + 'ch'; };
        inp.addEventListener('input', fit);
        inp.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const v = inp.value;
          inp.replaceWith(h('span', { class: 'u' }, v + '\n'));
          atStart = true; pending = null;
          resolve(v);
        });
        pending = { inp, reject };
      });
    },
    cancelRead() {
      if (!pending) return;
      pending.inp.remove(); pending.reject(new StopSignal()); pending = null;
    },
    focusInput() { if (pending) pending.inp.focus(); },
  };
})();

/* ===================================================================
   Éditeur (CodeMirror 5) — coloration pilotée par langage.json
   =================================================================== */
function defineMode(lang) {
  const kw = new Set();
  for (const [canon, list] of Object.entries(lang.json.motsCles)) {
    if (lang.soft.has(canon)) continue;
    for (const a of list) for (const w of normalise(a).split(/\s+/)) if (/^\p{L}/u.test(w) && !lang.soft.has(w)) kw.add(w);
  }
  const atoms = new Set([...(lang.json.motsCles.vrai || []), ...(lang.json.motsCles.faux || [])].map(normalise));
  for (const a of atoms) kw.delete(a);
  for (const w of ['la', 'ligne', 'retour', 'saut']) kw.add(w);
  CodeMirror.defineMode('pseudo', () => ({
    token(stream) {
      if (stream.eatSpace()) return null;
      if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
      if (stream.match(/^\/\*.*?(\*\/|$)/)) return 'comment';
      if (stream.match(/^jusqu['’]\p{L}/iu)) return 'keyword';
      if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'(?:[^'\\]|\\.)*'?/) || stream.match(/^“[^”]*”?/)) return 'string';
      if (stream.match(/^\d+(\.\d+)?/)) return 'number';
      if (stream.match(/^(<-|←|:=|<=|>=|<>|!=|==|\+=|-=|\.\.|[-+*\/%=<>])/)) return 'operator';
      if (stream.match(/^[\p{L}_][\p{L}\p{N}_]*/u)) {
        const w = normalise(stream.current());
        if (kw.has(w)) return 'keyword';
        if (lang.types.has(w)) return 'type';
        if (atoms.has(w)) return 'atom';
        if (lang.funcs.has(w)) return 'builtin';
        return 'variable';
      }
      stream.next();
      return null;
    },
  }));
}

function setupEditor() {
  const cm = CodeMirror.fromTextArea($('#code'), {
    mode: 'pseudo', lineNumbers: true, indentWithTabs: true, tabSize: 2, indentUnit: 2,
    gutters: ['CodeMirror-linenumbers', 'err-gutter'], lineWrapping: false, autofocus: true,
    extraKeys: {
      'Ctrl-Enter': () => run(), 'Cmd-Enter': () => run(),
      'Ctrl-S': () => save(), 'Cmd-S': () => save(),
    },
  });
  cm.on('change', () => { setDirty(true); clearErrLine(); });
  state.cm = cm;
}
function clearErrLine() {
  if (state.errLine == null) return;
  state.cm.removeLineClass(state.errLine, 'background', 'cm-errline');
  state.cm.setGutterMarker(state.errLine, 'err-gutter', null);
  state.errLine = null;
}
function markErrLine(line1) {
  clearErrLine();
  const l = Math.min(Math.max(line1 - 1, 0), state.cm.lineCount() - 1);
  state.cm.addLineClass(l, 'background', 'cm-errline');
  state.cm.setGutterMarker(l, 'err-gutter', h('span', { class: 'err-marker', title: 'Erreur ici' }, '✗'));
  state.cm.scrollIntoView({ line: l, ch: 0 }, 80);
  state.errLine = l;
}
function setDirty(v) { state.dirty = v; $('#dirty').hidden = !v; }

/* ===================================================================
   Document courant
   =================================================================== */
function setDoc({ id = null, owner = null, author = null, isCopy = false, title = '', td = '', code, project = null }) {
  state.doc = { id, owner, author, isCopy, project };
  $('#title').value = title; $('#td').value = td;
  state.cm.setValue(code); state.cm.clearHistory();
  clearErrLine(); setDirty(false);
  renderInfoBar();
  updateRunButton();
}
function renderInfoBar() {
  const { author, owner, isCopy, project } = state.doc;
  const bar = $('#info-bar');
  const parts = [];
  if (project) {
    parts.push(h('strong', {}, `Projet « ${project.title} »`));
    if (project.instructions) parts.push(' — ', project.instructions);
  }
  let who = '';
  if (author && state.me && owner !== state.me.id) {
    who = isCopy
      ? `Programme de ${author} — c'est une copie : modifie-le à ta guise, et enregistre-le pour le garder dans « Mes programmes ».`
      : `Programme de ${author} — tu es admin : « Enregistrer » modifie l'original.`;
  } else if (author && !state.me) who = `Programme de ${author} — connecte-toi pour en enregistrer une copie.`;
  if (who) parts.push(parts.length ? '\n' : '', who);
  bar.replaceChildren(...parts);
  bar.hidden = !parts.length;
}
const confirmDiscard = () => !state.dirty || confirm('Tu as des modifications non enregistrées. Les abandonner ?');

async function newDoc(code = state.modele, title = '', td = '') {
  if (!confirmDiscard()) return;
  setDoc({ title, td, code });
  con.clear();
  showView('editor');
}

async function save() {
  if (!state.me) return openAuth('Connecte-toi pour enregistrer tes programmes.');
  const title = $('#title').value.trim() || 'Sans titre';
  const td = $('#td').value.trim();
  // une copie du travail d'un autre n'entre pas dans le projet : elle devient un programme libre
  const project = state.doc.project && !state.doc.isCopy ? state.doc.project : null;
  if (!project && !canFree())
    return toast('Ton prof a limité l\'enregistrement aux projets : ouvre un projet dans l\'onglet « Projets ».', 'err');
  try {
    const canUpdate = state.doc.id && !state.doc.isCopy;
    const row = await state.backend.save({ id: canUpdate ? state.doc.id : null, title, td, code: state.cm.getValue(), project_id: project ? project.id : null });
    state.doc = { id: row.id, owner: row.owner, author: row.author, isCopy: false, project: state.doc.project };
    renderInfoBar();
    $('#title').value = row.title;
    setDirty(false);
    toast('Enregistré ✓');
    if (state.me && row.owner === state.me.id) $('#info-bar').hidden = true;
  } catch (e) { toast(e.message, 'err'); }
}

/* ===================================================================
   Exécution
   =================================================================== */
async function run() {
  if (state.running) return;
  await refreshPerms();
  const why = runBlock();
  if (why) return toast(why, 'err');
  clearErrLine(); con.clear();
  state.running = true;
  $('#btn-run').disabled = true; $('#btn-stop').disabled = false;
  const t0 = performance.now();
  const r = await runSource(state.cm.getValue(), state.lang, con, {
    sortirRetourLigne: $('#opt-nl').checked,
    strict: $('#opt-strict').checked,
    onReady: (it) => { state.interp = it; },
  });
  const ms = Math.round(performance.now() - t0);
  if (r.ok) con.info(`✓ Programme terminé (${ms} ms)`);
  else if (r.stopped) con.info('■ Exécution arrêtée');
  else { con.error(r.error.message); if (r.error.line) markErrLine(r.error.line); }
  state.running = false; state.interp = null;
  $('#btn-stop').disabled = true;
  updateRunButton();
}
function stop() {
  if (!state.running) return;
  if (state.interp) state.interp.stop();
  con.cancelRead();
}

/* ===================================================================
   Permissions (réglées par l'admin). Une permission n'est donnée que si
   TOUS les niveaux sont d'accord : global ET étudiant (ET projet).
   ⚠ L'exécution se fait dans le navigateur : ce blocage est dans l'interface seulement.
   L'enregistrement et la lecture, eux, sont aussi vérifiés par la base (RLS).
   =================================================================== */
const isAdmin = () => !!(state.me && state.me.role === 'admin');
function runBlock() {
  if (isAdmin()) return null;
  if (!state.settings.run_enabled) return 'L\'exécution est désactivée pour tout le monde par ton prof.';
  if (state.me && state.me.can_run === false) return 'Ton prof a désactivé l\'exécution pour ton compte.';
  const p = state.doc.project;
  if (p && !p.run_enabled) return `L'exécution est désactivée dans le projet « ${p.title} ».`;
  return null;
}
const canFree = () => isAdmin() || (!!state.me && state.settings.free_programs && state.me.can_free !== false);
function updateRunButton() {
  const why = runBlock();
  const btn = $('#btn-run');
  btn.disabled = state.running || !!why;
  btn.title = why || 'Ctrl + Entrée';
  const lock = $('#run-lock');
  lock.textContent = why ? '🔒 ' + why : '';
  lock.hidden = !why;
}
// relit les réglages juste avant d'exécuter (l'admin a pu les changer depuis le chargement de la page)
async function refreshPerms() {
  if (isAdmin()) return;
  const tasks = [state.backend.getSettings().then((x) => { state.settings = x; })];
  if (state.me) tasks.push(state.backend.session().then((m) => { if (m) state.me = m; }));
  const p = state.doc.project;
  if (state.me && p) tasks.push(state.backend.getProject(p.id).then((x) => { if (x && state.doc.project === p) state.doc.project = x; }));
  await Promise.allSettled(tasks);
  updateRunButton();
}
async function projectById(id) {
  const known = state.projects.find((x) => x.id === id);
  if (known) return known;
  try { return (await state.backend.getProject(id)) || null; } catch { return null; }
}

/* ===================================================================
   Chargement de modèles / exemples
   =================================================================== */
async function fillLoader() {
  const sel = $('#loader');
  sel.length = 1;
  const g1 = h('optgroup', { label: 'Base' }, h('option', { value: 'base' }, 'Modèle de base (squelette + aide-mémoire)'));
  sel.append(g1);
  if (state.examples.length) sel.append(h('optgroup', { label: 'Exemples corrigés' }, state.examples.map((e) => h('option', { value: 'ex:' + e.id }, e.titre))));
  if (state.templates.length) sel.append(h('optgroup', { label: 'Modèles du prof' }, state.templates.map((t) => h('option', { value: 'tpl:' + t.id }, t.title))));
}
async function refreshTemplates() {
  try { state.templates = await state.backend.listTemplates(); } catch { state.templates = []; }
  await fillLoader();
}
async function onLoaderChange(e) {
  const v = e.target.value; e.target.value = '';
  if (!v || !confirmDiscard()) return;
  if (v === 'base') return newDoc(state.modele, '', '');
  if (v.startsWith('ex:')) {
    const ex = state.examples.find((x) => x.id === v.slice(3));
    try {
      const code = await (await fetch('lang/exemples/' + ex.fichier)).text();
      setDoc({ title: ex.titre, td: ex.td, code }); con.clear(); showView('editor');
    } catch { toast('Impossible de charger cet exemple.', 'err'); }
  } else if (v.startsWith('tpl:')) {
    const t = state.templates.find((x) => x.id === v.slice(4));
    if (t) { setDoc({ title: t.title, td: t.td, code: t.code }); con.clear(); showView('editor'); }
  }
}
async function openProgram(p) {
  if (!confirmDiscard()) return;
  const mine = state.me && p.owner === state.me.id;
  const editOriginal = mine || (state.me && state.me.role === 'admin');
  const project = p.project_id ? await projectById(p.project_id) : null;
  setDoc({
    id: editOriginal ? p.id : null, owner: p.owner, author: p.author, isCopy: !editOriginal,
    title: editOriginal ? p.title : p.title + ' (copie)', td: p.td, code: p.code, project,
  });
  con.clear(); showView('editor');
}

/* ===================================================================
   Vues : liste, partagés, admin
   =================================================================== */
const needLogin = (body, msg) => {
  body.replaceChildren(h('div', { class: 'empty' }, msg + ' ', h('button', { class: 'link', onclick: () => openAuth() }, 'Se connecter')));
};

async function renderMine() {
  const body = $('#mine-body');
  if (!state.me) return needLogin(body, 'Connecte-toi pour retrouver tes programmes.');
  body.textContent = 'Chargement…';
  try {
    const [rows, projects] = await Promise.all([state.backend.listMine(), state.backend.listProjects().catch(() => [])]);
    state.projects = projects;
    const projName = new Map(projects.map((x) => [x.id, x.title]));
    if (!rows.length) return body.replaceChildren(h('div', { class: 'empty' }, 'Aucun programme enregistré pour l\'instant. Écris du code dans l\'éditeur (ou ouvre un projet) puis clique sur « Enregistrer ».'));
    body.replaceChildren(h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, ['Titre', 'Projet', 'TD', 'Modifié', 'Statut', ''].map((c) => h('th', {}, c)))),
      h('tbody', {}, rows.map((p) => h('tr', {},
        h('td', {}, h('button', { class: 'link', onclick: () => openProgram(p) }, p.title)),
        h('td', {}, p.project_id ? projName.get(p.project_id) || '?' : '—'),
        h('td', {}, p.td || '—'),
        h('td', {}, fmtDate(p.updated_at)),
        h('td', {}, p.published ? h('span', { class: 'badge pub' }, 'Partagé') : '', ' ', p.is_template ? h('span', { class: 'badge tpl' }, 'Modèle') : ''),
        h('td', {}, h('div', { class: 'actions' },
          h('button', { class: 'btn small', onclick: () => openProgram(p) }, 'Ouvrir'),
          h('button', { class: 'btn small danger', onclick: () => removeProgram(p, renderMine) }, 'Supprimer'))),
      ))))));
  } catch (e) { body.replaceChildren(h('div', { class: 'empty' }, e.message)); }
}

async function removeProgram(p, after) {
  if (!confirm(`Supprimer « ${p.title} » ? Cette action est définitive.`)) return;
  try {
    await state.backend.remove(p.id);
    if (state.doc.id === p.id) state.doc.id = null;
    toast('Supprimé'); after();
  } catch (e) { toast(e.message, 'err'); }
}

async function renderShared() {
  const body = $('#shared-body');
  if (!state.me) return needLogin(body, 'Connecte-toi pour voir les programmes partagés.');
  body.textContent = 'Chargement…';
  try {
    const rows = await state.backend.listShared();
    if (!rows.length) return body.replaceChildren(h('div', { class: 'empty' }, 'Rien de partagé pour l\'instant. Les corrigés apparaîtront ici quand ton prof les publiera.'));
    const groups = new Map();
    for (const p of rows) { const k = p.td || 'Autres'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
    body.replaceChildren(...[...groups].sort(([a], [b]) => a.localeCompare(b, 'fr', { numeric: true })).flatMap(([td, list]) => [
      h('h2', { class: 'group-title' }, td),
      h('div', { class: 'shared-grid' }, list.map((p) => h('div', { class: 'card' },
        h('h3', {}, p.title),
        h('div', { class: 'meta' }, 'par ', p.author, ' · ', fmtDate(p.updated_at), ' ', p.is_template ? h('span', { class: 'badge tpl' }, 'Modèle') : ''),
        h('button', { class: 'btn small primary', onclick: () => openProgram(p) }, 'Ouvrir une copie')))),
    ]));
  } catch (e) { body.replaceChildren(h('div', { class: 'empty' }, e.message)); }
}

async function renderAdmin() {
  const body = $('#admin-body');
  if (!state.me || state.me.role !== 'admin') return body.replaceChildren(h('div', { class: 'empty' }, 'Cette page est réservée à l\'admin.'));
  body.textContent = 'Chargement…';
  try {
    const [rows, students, settings, projects] = await Promise.all([
      state.backend.listAll(), state.backend.listStudents(), state.backend.getSettings(), state.backend.listProjects().catch(() => []),
    ]);
    state.settings = settings; state.projects = projects;
    const projName = new Map(projects.map((x) => [x.id, x.title]));
    const authors = new Set(rows.map((r) => r.author));
    const filter = h('input', { type: 'search', placeholder: 'Filtrer par pseudo, titre ou TD…', 'aria-label': 'Filtrer' });
    const tbody = h('tbody');
    const draw = () => {
      const q = normalise(filter.value);
      const shown = rows.filter((p) => !q || normalise(`${p.author} ${p.title} ${p.td} ${projName.get(p.project_id) || ''}`).includes(q));
      if (!shown.length) { tbody.replaceChildren(h('tr', {}, h('td', { colspan: 8, class: 'muted' }, 'Aucun programme.'))); return; }
      tbody.replaceChildren(...shown.map((p) => h('tr', {},
        h('td', {}, p.author),
        h('td', {}, h('button', { class: 'link', onclick: () => openProgram(p) }, p.title)),
        h('td', {}, p.project_id ? projName.get(p.project_id) || '?' : '—'),
        h('td', {}, p.td || '—'),
        h('td', {}, fmtDate(p.updated_at)),
        h('td', {}, h('input', { type: 'checkbox', checked: !!p.published, 'aria-label': 'Publié', onchange: (e) => flag(p, { published: e.target.checked }, e.target) })),
        h('td', {}, h('input', { type: 'checkbox', checked: !!p.is_template, 'aria-label': 'Modèle', onchange: (e) => flag(p, { is_template: e.target.checked }, e.target) })),
        h('td', {}, h('div', { class: 'actions' },
          h('button', { class: 'btn small', onclick: () => openProgram(p) }, 'Ouvrir'),
          h('button', { class: 'btn small danger', onclick: () => removeProgram(p, renderAdmin) }, 'Supprimer'))),
      )));
    };
    filter.addEventListener('input', draw);
    async function flag(p, f, box) {
      try { await state.backend.setFlags(p.id, f); Object.assign(p, f); toast('Mis à jour ✓'); refreshTemplates(); }
      catch (e) { box.checked = !box.checked; toast(e.message, 'err'); }
    }
    body.replaceChildren(
      permsPanel(students),
      h('h2', { class: 'group-title' }, 'Tous les programmes'),
      h('div', { class: 'admin-tools' }, filter, h('span', { class: 'stat' }, `${rows.length} programme(s) · ${authors.size} auteur(s)`)),
      h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, ['Auteur', 'Titre', 'Projet', 'TD', 'Modifié', 'Publié', 'Modèle', ''].map((c) => h('th', {}, c)))), tbody)));
    draw();
  } catch (e) { body.replaceChildren(h('div', { class: 'empty' }, e.message)); }
}

// Réglages globaux + permissions de chaque étudiant
function permsPanel(students) {
  const globalSwitch = (key, label, help) => h('label', {},
    h('input', {
      type: 'checkbox', checked: !!state.settings[key],
      onchange: async (e) => {
        const v = e.target.checked;
        try { await state.backend.setSettings({ [key]: v }); state.settings[key] = v; toast('Réglage enregistré ✓'); }
        catch (err) { e.target.checked = !v; toast(err.message, 'err'); }
      },
    }),
    h('span', {}, h('strong', {}, label), ' — ', help));
  const cols = [['can_run', 'Exécution'], ['can_free', 'Programmes libres'], ['can_view_others', 'Voir le travail des autres']];
  const boxes = new Map(cols.map(([k]) => [k, []]));
  const setAll = async (k, v) => {
    try {
      await state.backend.setAllStudents({ [k]: v });
      for (const s of students) s[k] = v;
      for (const b of boxes.get(k)) b.checked = v;
      toast('Mis à jour pour tous les étudiants ✓');
    } catch (err) { toast(err.message, 'err'); }
  };
  const table = h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Étudiant'), cols.map(([k, label]) => h('th', { class: 'c' }, label,
      h('span', { class: 'all' },
        h('button', { class: 'link', 'aria-label': `${label} : cocher pour tous`, onclick: () => setAll(k, true) }, 'tous'), ' · ',
        h('button', { class: 'link', 'aria-label': `${label} : décocher pour tous`, onclick: () => setAll(k, false) }, 'aucun')))))),
    h('tbody', {}, students.map((s) => h('tr', {}, h('td', {}, s.pseudo), cols.map(([k, label]) => {
      const b = h('input', {
        type: 'checkbox', checked: s[k] !== false, 'aria-label': `${label} pour ${s.pseudo}`,
        onchange: async () => {
          try { await state.backend.setStudent(s.id, { [k]: b.checked }); s[k] = b.checked; toast('Mis à jour ✓'); }
          catch (err) { b.checked = !b.checked; toast(err.message, 'err'); }
        },
      });
      boxes.get(k).push(b);
      return h('td', { class: 'c' }, b);
    }))))));
  return h('div', { class: 'panel' },
    h('h2', {}, 'Réglages'),
    h('p', { class: 'lead' }, 'Une permission ne marche que si tout est coché : le réglage global ET celui de l\'étudiant (ET celui du projet pour l\'exécution et le travail des autres). Toi, l\'admin, tu peux toujours tout faire.'),
    h('div', { class: 'switches' },
      globalSwitch('run_enabled', 'Exécution pour tous', 'décoché : plus aucun étudiant ne peut exécuter.'),
      globalSwitch('free_programs', 'Programmes libres pour tous', 'décoché : les étudiants ne peuvent enregistrer que dans tes projets (ils peuvent toujours ouvrir leurs anciens programmes).')),
    students.length ? table : h('div', { class: 'empty' }, 'Aucun étudiant inscrit pour l\'instant.'));
}

/* ===================================================================
   Projets
   =================================================================== */
const empty = (msg) => h('div', { class: 'empty' }, msg);

async function renderProjects() {
  const body = $('#projects-body');
  $('#projects-lead').textContent = isAdmin()
    ? 'Crée des exercices pour la promo. Chaque étudiant y fait son propre travail ; tu choisis pour chaque projet si l\'exécution est permise et si les étudiants voient le travail des autres.'
    : 'Les exercices donnés par ton prof. Ouvre un projet pour y faire ton travail : il est enregistré à ton nom dans ce projet.';
  if (!state.me) return needLogin(body, 'Connecte-toi pour voir les projets de ton prof.');
  body.textContent = 'Chargement…';
  try {
    const list = await state.backend.listProjects();
    state.projects = list;
    if (isAdmin()) return drawAdminProjects(body, list);
    const mine = await state.backend.listMine();
    const started = new Set(mine.filter((p) => p.project_id).map((p) => p.project_id));
    if (!list.length) return body.replaceChildren(empty('Aucun projet pour l\'instant.'));
    body.replaceChildren(h('div', { class: 'shared-grid' }, list.map((pr) => h('div', { class: 'card' },
      h('h3', {}, pr.title),
      h('div', { class: 'meta' }, pr.td ? pr.td + ' ' : '',
        started.has(pr.id) ? h('span', { class: 'badge pub' }, 'Commencé') : '', ' ',
        pr.run_enabled ? '' : h('span', { class: 'badge off' }, 'Exécution désactivée')),
      pr.instructions ? h('p', { class: 'consigne' }, pr.instructions) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn small primary', onclick: () => openMyProjectWork(pr) }, started.has(pr.id) ? 'Ouvrir mon travail' : 'Commencer'),
        pr.share_work && state.me.can_view_others !== false
          ? h('button', { class: 'btn small', onclick: () => renderProjectWork(pr) }, 'Voir le travail des autres') : null)))));
  } catch (e) { body.replaceChildren(empty(e.message)); }
}

function drawAdminProjects(body, list) {
  const toggle = (pr, key, label) => h('label', {},
    h('input', {
      type: 'checkbox', checked: !!pr[key],
      onchange: async (e) => {
        const v = e.target.checked;
        try { await state.backend.saveProject({ id: pr.id, [key]: v }); pr[key] = v; toast('Projet mis à jour ✓'); }
        catch (err) { e.target.checked = !v; toast(err.message, 'err'); }
      },
    }), label);
  const head = h('div', { class: 'admin-tools' },
    h('button', { class: 'btn primary', onclick: () => openProjectDialog() }, '+ Nouveau projet'),
    h('span', { class: 'stat' }, `${list.length} projet(s)`));
  if (!list.length) return body.replaceChildren(head, empty('Aucun projet. Crée le premier avec « Nouveau projet ».'));
  body.replaceChildren(head, h('div', { class: 'shared-grid' }, list.map((pr) => h('div', { class: 'card' },
    h('h3', {}, pr.title),
    h('div', { class: 'meta' }, pr.td ? pr.td + ' · ' : '', 'créé le ', fmtDate(pr.created_at)),
    pr.instructions ? h('p', { class: 'consigne' }, pr.instructions) : null,
    h('div', { class: 'toggles' },
      toggle(pr, 'run_enabled', 'Exécution autorisée'),
      toggle(pr, 'share_work', 'Les étudiants voient le travail des autres')),
    h('div', { class: 'row' },
      h('button', { class: 'btn small primary', onclick: () => renderProjectWork(pr) }, 'Travail des étudiants'),
      h('button', { class: 'btn small', onclick: () => openProjectDialog(pr) }, 'Modifier'),
      h('button', { class: 'btn small danger', onclick: () => removeProject(pr) }, 'Supprimer'))))));
}

async function renderProjectWork(pr) {
  const body = $('#projects-body');
  body.textContent = 'Chargement…';
  const back = h('p', { class: 'back' }, h('button', { class: 'link', onclick: renderProjects }, '← Tous les projets'));
  const title = h('h2', { class: 'group-title' }, `Travail rendu — ${pr.title}`);
  try {
    const rows = await state.backend.listProjectWork(pr.id);
    let missing = null;
    if (isAdmin()) {
      const students = await state.backend.listStudents();
      const done = new Set(rows.map((r) => r.owner));
      const names = students.filter((s) => !done.has(s.id)).map((s) => s.pseudo);
      missing = h('p', { class: 'muted' }, names.length ? `Pas encore commencé (${names.length}) : ${names.join(', ')}` : 'Tous les étudiants inscrits ont commencé.');
    }
    if (!rows.length) return body.replaceChildren(back, title, empty('Personne n\'a encore enregistré de travail dans ce projet.'), missing || '');
    body.replaceChildren(back, title, h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, ['Étudiant', 'Titre', 'Modifié', ''].map((c) => h('th', {}, c)))),
      h('tbody', {}, rows.map((p) => h('tr', {},
        h('td', {}, p.author),
        h('td', {}, p.title),
        h('td', {}, fmtDate(p.updated_at)),
        h('td', {}, h('div', { class: 'actions' },
          h('button', { class: 'btn small', onclick: () => openProgram(p) }, isAdmin() || p.owner === state.me.id ? 'Ouvrir' : 'Ouvrir une copie')))))))),
    missing || '');
  } catch (e) { body.replaceChildren(back, title, empty(e.message)); }
}

async function openMyProjectWork(pr) {
  if (!confirmDiscard()) return;
  try {
    const mine = (await state.backend.listProjectWork(pr.id)).find((p) => p.owner === state.me.id);
    if (mine) setDoc({ id: mine.id, owner: mine.owner, author: mine.author, title: mine.title, td: mine.td, code: mine.code, project: pr });
    else setDoc({ title: pr.title, td: pr.td, code: pr.starter_code || state.modele, project: pr });
    con.clear(); showView('editor');
    if (!mine) toast('Projet ouvert : clique sur « Enregistrer » pour garder ton travail.');
  } catch (e) { toast(e.message, 'err'); }
}

async function removeProject(pr) {
  if (!confirm(`Supprimer le projet « ${pr.title} » ?\n\nLe travail déjà enregistré par les étudiants n'est pas effacé : il reste dans leurs « Mes programmes ».`)) return;
  try {
    await state.backend.removeProject(pr.id);
    if (state.doc.project && state.doc.project.id === pr.id) { state.doc.project = null; renderInfoBar(); updateRunButton(); }
    toast('Projet supprimé'); renderProjects();
  } catch (e) { toast(e.message, 'err'); }
}

let editingProject = null;
function projectMsg(text) { const m = $('#project-msg'); m.textContent = text; m.hidden = !text; }
function openProjectDialog(pr = null) {
  editingProject = pr;
  const f = $('#project-form');
  f.reset();
  $('#project-title').textContent = pr ? 'Modifier le projet' : 'Nouveau projet';
  $('#project-submit').textContent = pr ? 'Enregistrer' : 'Créer le projet';
  if (pr) {
    $('#p-title').value = pr.title; $('#p-td').value = pr.td || '';
    $('#p-instructions').value = pr.instructions || ''; $('#p-code').value = pr.starter_code || '';
    f.elements['p-run'].value = pr.run_enabled ? '1' : '0';
    f.elements['p-share'].value = pr.share_work ? '1' : '0';
  }
  projectMsg('');
  $('#project-dialog').showModal();
  $('#p-title').focus();
}
async function submitProject(e) {
  e.preventDefault();
  const f = $('#project-form');
  const fields = {
    title: $('#p-title').value.trim(), td: $('#p-td').value.trim(),
    instructions: $('#p-instructions').value.trim(), starter_code: $('#p-code').value,
    run_enabled: f.elements['p-run'].value === '1', share_work: f.elements['p-share'].value === '1',
  };
  if (!fields.title) return projectMsg('Donne un titre au projet.');
  const btn = $('#project-submit'); btn.disabled = true;
  try {
    await state.backend.saveProject(editingProject ? { id: editingProject.id, ...fields } : fields);
    $('#project-dialog').close();
    toast(editingProject ? 'Projet modifié ✓' : 'Projet créé ✓');
    renderProjects();
  } catch (err) { projectMsg(err.message); }
  finally { btn.disabled = false; }
}

/* ===================================================================
   Navigation
   =================================================================== */
const VIEWS = ['editor', 'projects', 'mine', 'shared', 'admin', 'help'];
function showView(name) {
  if (!VIEWS.includes(name)) name = 'editor';
  if (name === 'admin' && !(state.me && state.me.role === 'admin')) name = 'editor';
  state.view = name;
  for (const v of VIEWS) $('#view-' + v).hidden = v !== name;
  for (const b of $$('#nav button')) {
    if (b.dataset.view === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
  if (name === 'projects') renderProjects();
  if (name === 'mine') renderMine();
  if (name === 'shared') renderShared();
  if (name === 'admin') renderAdmin();
  if (name === 'editor') state.cm.refresh();
}

/* ===================================================================
   Comptes
   =================================================================== */
function renderAuthBox() {
  const box = $('#authbox');
  if (state.me) {
    box.replaceChildren(
      h('span', { class: 'who' }, state.me.pseudo, ' ', state.me.role === 'admin' ? h('span', { class: 'badge admin' }, 'admin') : ''),
      h('button', { class: 'btn small', onclick: logout }, 'Déconnexion'));
  } else {
    box.replaceChildren(h('button', { class: 'btn small primary', onclick: () => openAuth() }, 'Connexion'));
  }
  $('[data-view=admin]').hidden = !(state.me && state.me.role === 'admin');
  renderInfoBar();
  updateRunButton();
}
async function logout() {
  if (!confirmDiscard()) return;
  await state.backend.signOut();
  state.me = null; renderAuthBox();
  setDirty(false);
  if (['projects', 'mine', 'shared', 'admin'].includes(state.view)) showView(state.view === 'admin' ? 'editor' : state.view);
  toast('Déconnecté');
}

let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  for (const b of $$('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  $('#f-pseudo').hidden = mode !== 'signup';
  $('#a-pseudo').required = mode === 'signup';
  $('#a-pass').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  $('#auth-title').textContent = mode === 'signup' ? 'Créer un compte' : 'Connexion';
  $('#auth-submit').textContent = mode === 'signup' ? 'Créer mon compte' : 'Se connecter';
  authMsg('');
}
function authMsg(text, ok = false) {
  const m = $('#auth-msg'); m.textContent = text; m.hidden = !text; m.classList.toggle('ok', ok);
}
function openAuth(why = '') {
  setAuthMode('login');
  const w = $('#auth-why'); w.textContent = why; w.hidden = !why;
  $('#auth-dialog').showModal();
  $('#a-email').focus();
}
async function submitAuth(e) {
  e.preventDefault();
  const email = $('#a-email').value.trim(), password = $('#a-pass').value, pseudo = $('#a-pseudo').value.trim();
  const btn = $('#auth-submit'); btn.disabled = true;
  try {
    state.me = authMode === 'signup'
      ? await state.backend.signUp({ email, password, pseudo })
      : await state.backend.signIn({ email, password });
    $('#auth-dialog').close();
    $('#auth-form').reset();
    renderAuthBox(); refreshTemplates();
    toast(`Bienvenue ${state.me.pseudo} !`);
    refreshPerms();
    if (['projects', 'mine', 'shared', 'admin'].includes(state.view)) showView(state.view);
  } catch (err) { authMsg(err.message, !!err.info); }
  finally { btn.disabled = false; }
}

/* ===================================================================
   Démarrage
   =================================================================== */
async function init() {
  // --- langage ---
  state.langJson = await (await fetch('lang/langage.json')).json();
  state.lang = makeLang(state.langJson);
  defineMode(state.lang);
  setupEditor();

  const [modele, examples] = await Promise.all([
    fetch('lang/modele.pseudo').then((r) => r.text()),
    fetch('lang/exemples/index.json').then((r) => r.json()).catch(() => []),
  ]);
  state.modele = modele; state.examples = examples;
  state.cm.setValue(modele); state.cm.clearHistory(); setDirty(false);

  // --- options de la console ---
  $('#opt-nl').checked = pref.get('nl', String(!!state.lang.options.sortirRetourLigne)) === 'true';
  $('#opt-strict').checked = pref.get('strict', 'false') === 'true';
  $('#opt-nl').addEventListener('change', (e) => pref.set('nl', e.target.checked));
  $('#opt-strict').addEventListener('change', (e) => pref.set('strict', e.target.checked));

  // --- backend : Supabase si configuré, sinon mode démo ---
  const useSupabase = CONFIG.supabaseUrl && CONFIG.supabaseAnonKey;
  try {
    if (useSupabase) {
      await loadScript('vendor/supabase.js');
      const { createSupabaseBackend } = await import('./backend-supabase.js');
      state.backend = createSupabaseBackend(CONFIG);
    }
  } catch (e) { toast('Supabase injoignable, passage en mode démo.', 'err'); }
  if (!state.backend) state.backend = createLocalBackend();
  $('#demo-banner').hidden = !state.backend.demo;

  try { state.me = await state.backend.session(); } catch { state.me = null; }
  try { state.settings = await state.backend.getSettings(); } catch { /* valeurs par défaut */ }
  renderAuthBox();
  await fillLoader();
  if (state.me) refreshTemplates();

  // --- événements ---
  $('#btn-run').addEventListener('click', run);
  $('#btn-stop').addEventListener('click', stop);
  $('#btn-save').addEventListener('click', save);
  $('#btn-new').addEventListener('click', () => newDoc());
  $('#btn-clear').addEventListener('click', () => { con.clear(); clearErrLine(); });
  $('#loader').addEventListener('change', onLoaderChange);
  $('#title').addEventListener('input', () => setDirty(true));
  $('#td').addEventListener('input', () => setDirty(true));
  $('#console').addEventListener('click', () => con.focusInput());
  $('#nav').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) showView(b.dataset.view); });
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.mode)));
  $('#auth-form').addEventListener('submit', submitAuth);
  $('#auth-cancel').addEventListener('click', () => $('#auth-dialog').close());
  $('#project-form').addEventListener('submit', submitProject);
  $('#project-cancel').addEventListener('click', () => $('#project-dialog').close());
  $('#p-take-editor').addEventListener('click', () => { $('#p-code').value = state.cm.getValue(); });
  $('#p-take-modele').addEventListener('click', () => { $('#p-code').value = state.modele; });
  window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
  window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

  showView(location.hash.slice(1) || 'editor');
  window.__pl = state;   // pratique pour déboguer dans la console du navigateur
}

init().catch((e) => {
  document.body.prepend(h('pre', { style: 'color:#b42318;padding:16px;white-space:pre-wrap' },
    'Erreur au démarrage : ' + e.message + '\n\nSi tu as ouvert index.html en double-cliquant, il faut passer par un petit serveur (voir le README : python3 -m http.server).'));
  console.error(e);
});
