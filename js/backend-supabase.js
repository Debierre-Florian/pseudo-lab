// Vrais comptes + base partagée via Supabase (gratuit). Voir supabase/schema.sql
// La page doit avoir chargé vendor/supabase.js (global `supabase`).

export function createSupabaseBackend(cfg) {
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  async function profileOf(user) {
    const { data } = await sb.from('profiles').select('pseudo, role').eq('id', user.id).maybeSingle();
    return {
      id: user.id,
      email: user.email,
      pseudo: (data && data.pseudo) || (user.user_metadata && user.user_metadata.pseudo) || user.email.split('@')[0],
      role: (data && data.role) || 'student',
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
    async save({ id, title, td, code }) {
      const q = id
        ? sb.from('programs').update({ title, td, code }).eq('id', id)
        : sb.from('programs').insert({ title, td, code });
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
  };
}
