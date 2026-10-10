// Mode démo : tout est stocké dans le navigateur (localStorage). Aucun serveur.
// Le pseudo « admin » reçoit le rôle admin, pour pouvoir tester l'interface prof.

const mem = new Map();
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? (mem.has(k) ? mem.get(k) : d) : JSON.parse(v); } catch { return mem.has(k) ? mem.get(k) : d; } },
  set(k, v) { mem.set(k, v); try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* navigation privée : on garde en mémoire */ } },
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

export function createLocalBackend() {
  const users = () => store.get('pl_users', []);
  const progs = () => store.get('pl_programs', []);
  const publicUser = (u) => (u ? { id: u.id, email: u.email, pseudo: u.pseudo, role: u.role } : null);
  const withAuthor = (p) => ({ ...p, author: (users().find((u) => u.id === p.owner) || {}).pseudo || '?' });
  const me = () => users().find((u) => u.id === store.get('pl_session', null));
  const need = () => { const u = me(); if (!u) throw new Error('Connecte-toi pour faire ça.'); return u; };
  const byDate = (a, b) => (a.updated_at < b.updated_at ? 1 : -1);

  return {
    demo: true,
    async session() { return publicUser(me()); },
    async signUp({ email, password, pseudo }) {
      const list = users();
      if (list.some((u) => u.email.toLowerCase() === email.toLowerCase())) throw new Error('Cette adresse email a déjà un compte.');
      if (list.some((u) => u.pseudo.toLowerCase() === pseudo.toLowerCase())) throw new Error('Ce pseudo est déjà pris.');
      const u = { id: uid(), email, password, pseudo, role: pseudo.toLowerCase() === 'admin' ? 'admin' : 'student' };
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

    async listMine() { const u = need(); return progs().filter((p) => p.owner === u.id).map(withAuthor).sort(byDate); },
    async listShared() { return progs().filter((p) => p.published || p.is_template).map(withAuthor).sort(byDate); },
    async listAll() { const u = need(); if (u.role !== 'admin') throw new Error('Réservé à l\'admin.'); return progs().map(withAuthor).sort(byDate); },
    async listTemplates() { return progs().filter((p) => p.is_template).map(withAuthor).sort(byDate); },

    async save({ id, title, td, code }) {
      const u = need();
      const list = progs();
      const now = new Date().toISOString();
      if (id) {
        const p = list.find((x) => x.id === id);
        if (!p) throw new Error('Programme introuvable.');
        if (p.owner !== u.id && u.role !== 'admin') throw new Error('Ce programme ne t\'appartient pas.');
        Object.assign(p, { title, td, code, updated_at: now });
        store.set('pl_programs', list);
        return withAuthor(p);
      }
      const p = { id: uid(), owner: u.id, title, td, code, published: false, is_template: false, created_at: now, updated_at: now };
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
      const u = need();
      if (u.role !== 'admin') throw new Error('Réservé à l\'admin.');
      const list = progs();
      const p = list.find((x) => x.id === id);
      if (p) Object.assign(p, flags);
      store.set('pl_programs', list);
    },
  };
}
