// Mode démo : tout est stocké dans le navigateur (localStorage). Aucun serveur.
// Le pseudo « admin » reçoit le rôle admin, pour pouvoir tester l'interface prof.
// Les règles de permission imitent celles de supabase/schema.sql (RLS).

const mem = new Map();
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? (mem.has(k) ? mem.get(k) : d) : JSON.parse(v); } catch { return mem.has(k) ? mem.get(k) : d; } },
  set(k, v) { mem.set(k, v); try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* navigation privée : on garde en mémoire */ } },
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const PERMS = { can_run: true, can_free: true, can_view_others: true };

export function createLocalBackend() {
  const users = () => store.get('pl_users', []).map((u) => ({ ...PERMS, ...u }));
  const progs = () => store.get('pl_programs', []);
  const projs = () => store.get('pl_projects', []).map((p) => ({ visible: true, hidden_for: [], ...p }));
  const settings = () => ({ run_enabled: true, free_programs: true, ...store.get('pl_settings', {}) });
  const publicUser = (u) => (u ? { id: u.id, email: u.email, pseudo: u.pseudo, role: u.role, can_run: u.can_run, can_free: u.can_free, can_view_others: u.can_view_others } : null);
  const withAuthor = (p) => ({ project_id: null, ...p, author: (users().find((u) => u.id === p.owner) || {}).pseudo || '?' });
  const me = () => users().find((u) => u.id === store.get('pl_session', null));
  const need = () => { const u = me(); if (!u) throw new Error('Connecte-toi pour faire ça.'); return u; };
  const needAdmin = () => { const u = need(); if (u.role !== 'admin') throw new Error('Réservé à l\'admin.'); return u; };
  const byDate = (a, b) => (a.updated_at < b.updated_at ? 1 : -1);
  const canFree = (u) => u.role === 'admin' || (settings().free_programs && u.can_free);
  // comme can_use_project() : projet visible ET l'étudiant n'est pas dans la liste des masqués
  const canUse = (u, p) => !!p && (u.role === 'admin' || (p.visible && !p.hidden_for.includes(u.id)));
  const canSeeWork = (u, pid) => {
    const p = pid && projs().find((x) => x.id === pid);
    return canUse(u, p) && p.share_work && u.can_view_others;
  };
  const canSaveIn = (u, pid) => (pid ? canUse(u, projs().find((x) => x.id === pid)) : canFree(u));
  // comme le trigger programs_guard : un étudiant garde le titre et le TD du projet
  const projectNames = (u, pid, title, td) => {
    const pr = u.role !== 'admin' && pid && projs().find((x) => x.id === pid);
    return pr ? { title: pr.title, td: pr.td || '' } : { title, td };
  };
  const REFUS_LIBRE = 'Action refusée : ton prof n\'autorise pas ça (par exemple, enregistrer en dehors d\'un projet).';

  return {
    demo: true,
    async session() { return publicUser(me()); },
    async signUp({ email, password, pseudo }) {
      const list = store.get('pl_users', []);
      if (list.some((u) => u.email.toLowerCase() === email.toLowerCase())) throw new Error('Cette adresse email a déjà un compte.');
      if (list.some((u) => u.pseudo.toLowerCase() === pseudo.toLowerCase())) throw new Error('Ce pseudo est déjà pris.');
      const u = { id: uid(), email, password, pseudo, role: pseudo.toLowerCase() === 'admin' ? 'admin' : 'student', ...PERMS };
      store.set('pl_users', [...list, u]);
      store.set('pl_session', u.id);
      return publicUser(u);
    },
    async signIn({ email, password }) {
      const u = users().find((x) => x.email.toLowerCase() === email.toLowerCase() && x.password === password);
      if (!u) throw new Error('Email ou mot de passe incorrect.');
      store.set('pl_session', u.id);
      return publicUser(u);
    },
    async signOut() { store.set('pl_session', null); },

    // ----- programmes -----
    async listMine() { const u = need(); return progs().filter((p) => p.owner === u.id).map(withAuthor).sort(byDate); },
    async listShared() { return progs().filter((p) => p.published || p.is_template).map(withAuthor).sort(byDate); },
    async listAll() { needAdmin(); return progs().map(withAuthor).sort(byDate); },
    async listTemplates() { return progs().filter((p) => p.is_template).map(withAuthor).sort(byDate); },

    async save({ id, title, td, code, project_id = null }) {
      const u = need();
      const list = progs();
      const now = new Date().toISOString();
      if (id) {
        const p = list.find((x) => x.id === id);
        if (!p) throw new Error('Programme introuvable.');
        if (p.owner !== u.id && u.role !== 'admin') throw new Error('Ce programme ne t\'appartient pas.');
        if (u.role !== 'admin' && !canSaveIn(u, p.project_id)) throw new Error(REFUS_LIBRE);
        Object.assign(p, projectNames(u, p.project_id, title, td), { code, updated_at: now });
        store.set('pl_programs', list);
        return withAuthor(p);
      }
      if (u.role !== 'admin' && !canSaveIn(u, project_id)) throw new Error(REFUS_LIBRE);
      if (project_id && list.some((x) => x.owner === u.id && x.project_id === project_id))
        throw new Error('Tu as déjà un travail dans ce projet : ouvre-le depuis l\'onglet Projets.');
      const p = { id: uid(), owner: u.id, ...projectNames(u, project_id, title, td), code, project_id, published: false, is_template: false, created_at: now, updated_at: now };
      store.set('pl_programs', [...list, p]);
      return withAuthor(p);
    },
    async remove(id) {
      const u = need();
      const p = progs().find((x) => x.id === id);
      if (!p) return;
      if (p.owner !== u.id && u.role !== 'admin') throw new Error('Ce programme ne t\'appartient pas.');
      store.set('pl_programs', progs().filter((x) => x.id !== id));
    },
    async setFlags(id, flags) {
      needAdmin();
      const list = progs();
      const p = list.find((x) => x.id === id);
      if (p) Object.assign(p, flags);
      store.set('pl_programs', list);
    },

    // ----- réglages globaux -----
    async getSettings() { return settings(); },
    async setSettings(patch) { needAdmin(); store.set('pl_settings', { ...settings(), ...patch }); },

    // ----- projets -----
    async listProjects() { const u = need(); return projs().filter((p) => canUse(u, p)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); },
    async getProject(id) { const u = need(); const p = projs().find((x) => x.id === id); return canUse(u, p) ? p : null; },
    async saveProject({ id, ...fields }) {
      needAdmin();
      const list = projs();
      const now = new Date().toISOString();
      if (id) {
        const p = list.find((x) => x.id === id);
        if (!p) throw new Error('Projet introuvable.');
        Object.assign(p, fields, { updated_at: now });
        store.set('pl_projects', list);
        return p;
      }
      const p = { title: 'Projet', td: '', instructions: '', starter_code: '', run_enabled: true, share_work: false, visible: true, hidden_for: [], ...fields, id: uid(), created_at: now, updated_at: now };
      store.set('pl_projects', [...list, p]);
      return p;
    },
    async setProjectsFlags(ids, patch) {
      needAdmin();
      store.set('pl_projects', projs().map((p) => (ids.includes(p.id) ? { ...p, ...patch } : p)));
    },
    async removeProject(id) {
      needAdmin();
      store.set('pl_projects', projs().filter((p) => p.id !== id));
      // comme « on delete set null » : le travail des étudiants redevient un programme libre
      store.set('pl_programs', progs().map((p) => (p.project_id === id ? { ...p, project_id: null } : p)));
    },
    async listProjectWork(projectId) {
      const u = need();
      return progs()
        .filter((p) => p.project_id === projectId && (p.owner === u.id || u.role === 'admin' || canSeeWork(u, projectId)))
        .map(withAuthor).sort(byDate);
    },

    // ----- étudiants (admin) -----
    async listStudents() {
      needAdmin();
      return users().filter((u) => u.role !== 'admin').map(publicUser).sort((a, b) => a.pseudo.localeCompare(b.pseudo, 'fr'));
    },
    async setStudent(id, patch) {
      needAdmin();
      store.set('pl_users', store.get('pl_users', []).map((u) => (u.id === id ? { ...u, ...patch } : u)));
    },
    async setAllStudents(patch) {
      needAdmin();
      store.set('pl_users', store.get('pl_users', []).map((u) => (u.role !== 'admin' ? { ...u, ...patch } : u)));
    },
  };
}
