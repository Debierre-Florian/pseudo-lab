// Vrais comptes + base partagée via Supabase (gratuit). Voir supabase/schema.sql
// La page doit avoir chargé vendor/supabase.js (global `supabase`).

export function createSupabaseBackend(cfg) {
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  async function profileOf(user) {
    // select('*') : marche aussi tant que la migration « projets » n'a pas été lancée (colonnes absentes = autorisé)
    const { data } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    return {
      id: user.id,
      email: user.email,
      pseudo: (data && data.pseudo) || (user.user_metadata && user.user_metadata.pseudo) || user.email.split('@')[0],
      role: (data && data.role) || 'student',
      can_run: !data || data.can_run !== false,
      can_free: !data || data.can_free !== false,
      can_view_others: !data || data.can_view_others !== false,
    };
  }
  const fail = (error) => { if (error) throw new Error(translate(error.message)); };
  const toProg = (r) => ({ ...r, author: r.profiles ? r.profiles.pseudo : '?' });
  const SELECT = '*, profiles(pseudo)';

  function translate(m) {
    if (/Invalid login credentials/i.test(m)) return 'Email ou mot de passe incorrect.';
    if (/already registered/i.test(m)) return 'Cette adresse email a déjà un compte.';
    if (/Password should be at least/i.test(m)) return 'Mot de passe trop court (6 caractères minimum).';
    if (/Email not confirmed/i.test(m)) return 'Confirme d\'abord ton adresse email (regarde ta boîte mail).';
    if (/rate limit/i.test(m)) return 'Trop de tentatives, réessaie dans quelques minutes.';
    if (/row-level security/i.test(m)) return 'Action refusée : ton prof n\'autorise pas ça (par exemple, enregistrer en dehors d\'un projet).';
    if (/programs_one_per_project|duplicate key/i.test(m)) return 'Tu as déjà un travail dans ce projet : ouvre-le depuis l\'onglet Projets.';
    if (/relation .*(projects|settings).* does not exist|Could not find the table/i.test(m))
      return 'La base n\'est pas à jour : lance supabase/migration-projets.sql dans Supabase › SQL Editor.';
    return m;
  }

  return {
    demo: false,
    async session() {
      const { data } = await sb.auth.getSession();
      return data.session ? profileOf(data.session.user) : null;
    },
    async signUp({ email, password, pseudo }) {
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { pseudo } } });
      fail(error);
      if (!data.session) throw Object.assign(new Error('Compte créé ! Regarde ta boîte mail pour confirmer ton adresse, puis connecte-toi.'), { info: true });
      return profileOf(data.user);
    },
    async signIn({ email, password }) {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      fail(error);
      return profileOf(data.user);
    },
    async signOut() { await sb.auth.signOut(); },

    // ----- programmes -----
    async listMine() {
      const { data: { user } } = await sb.auth.getUser();
      const { data, error } = await sb.from('programs').select(SELECT).eq('owner', user.id).order('updated_at', { ascending: false });
      fail(error); return data.map(toProg);
    },
    async listShared() {
      const { data, error } = await sb.from('programs').select(SELECT).or('published.eq.true,is_template.eq.true').order('updated_at', { ascending: false });
      fail(error); return data.map(toProg);
    },
    async listAll() {
      const { data, error } = await sb.from('programs').select(SELECT).order('updated_at', { ascending: false });
      fail(error); return data.map(toProg);
    },
    async listTemplates() {
      const { data, error } = await sb.from('programs').select(SELECT).eq('is_template', true).order('title');
      fail(error); return data.map(toProg);
    },
    async save({ id, title, td, code, project_id = null }) {
      const q = id
        ? sb.from('programs').update({ title, td, code }).eq('id', id)
        : sb.from('programs').insert(project_id ? { title, td, code, project_id } : { title, td, code });
      const { data, error } = await q.select(SELECT).single();
      fail(error); return toProg(data);
    },
    async remove(id) {
      const { error } = await sb.from('programs').delete().eq('id', id);
      fail(error);
    },
    async setFlags(id, flags) {
      const { error } = await sb.from('programs').update(flags).eq('id', id);
      fail(error);
    },

    // ----- réglages globaux -----
    async getSettings() {
      const { data, error } = await sb.from('settings').select('run_enabled, free_programs').eq('id', 1).maybeSingle();
      if (error || !data) return { run_enabled: true, free_programs: true };   // migration pas encore lancée
      return data;
    },
    async setSettings(patch) {
      const { error } = await sb.from('settings').update(patch).eq('id', 1);
      fail(error);
    },

    // ----- projets -----
    async listProjects() {
      const { data, error } = await sb.from('projects').select('*').order('created_at', { ascending: false });
      fail(error); return data;
    },
    async getProject(id) {
      const { data, error } = await sb.from('projects').select('*').eq('id', id).maybeSingle();
      fail(error); return data;
    },
    async saveProject({ id, ...fields }) {
      const q = id ? sb.from('projects').update(fields).eq('id', id) : sb.from('projects').insert(fields);
      const { data, error } = await q.select('*').single();
      fail(error); return data;
    },
    async removeProject(id) {
      const { error } = await sb.from('projects').delete().eq('id', id);
      fail(error);
    },
    async listProjectWork(projectId) {
      const { data, error } = await sb.from('programs').select(SELECT).eq('project_id', projectId).order('updated_at', { ascending: false });
      fail(error); return data.map(toProg);
    },

    // ----- étudiants (admin) -----
    async listStudents() {
      const { data, error } = await sb.from('profiles').select('*').neq('role', 'admin').order('pseudo');
      fail(error);
      return data.map((p) => ({ ...p, can_run: p.can_run !== false, can_free: p.can_free !== false, can_view_others: p.can_view_others !== false }));
    },
    async setStudent(id, patch) {
      const { error } = await sb.from('profiles').update(patch).eq('id', id);
      fail(error);
    },
    async setAllStudents(patch) {
      const { error } = await sb.from('profiles').update(patch).neq('role', 'admin');
      fail(error);
    },
  };
}
