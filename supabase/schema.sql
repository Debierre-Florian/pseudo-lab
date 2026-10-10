-- =====================================================================
--  Pseudo-Lab — base de données Supabase
--  À coller UNE FOIS dans Supabase › SQL Editor › New query › Run
-- =====================================================================

-- 1) Profils : un pseudo + un rôle pour chaque compte ---------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  pseudo     text not null,
  role       text not null default 'student' check (role in ('student', 'admin')),
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_pseudo_key on public.profiles (lower(pseudo));
alter table public.profiles enable row level security;

-- Fonction "suis-je admin ?" (security definer pour éviter les boucles de règles)
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- Tout compte connecté peut lire les pseudos (pour afficher l'auteur).
-- Personne ne peut modifier un profil depuis le site : le rôle admin
-- ne se donne que depuis cet éditeur SQL (voir la fin du fichier).
drop policy if exists "profils lisibles" on public.profiles;
create policy "profils lisibles" on public.profiles for select to authenticated using (true);

-- Création automatique du profil à l'inscription (le pseudo vient du formulaire)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  wanted text := coalesce(nullif(trim(new.raw_user_meta_data->>'pseudo'), ''), split_part(new.email, '@', 1));
begin
  if exists (select 1 from public.profiles where lower(pseudo) = lower(wanted)) then
    wanted := wanted || '-' || substr(new.id::text, 1, 4);   -- pseudo déjà pris : on ajoute un suffixe
  end if;
  insert into public.profiles (id, pseudo) values (new.id, wanted);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2) Programmes ------------------------------------------------------------
create table if not exists public.programs (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  title       text not null default 'Sans titre',
  td          text not null default '',
  code        text not null default '',
  published   boolean not null default false,   -- l'admin le rend visible à tous
  is_template boolean not null default false,   -- l'admin le propose comme modèle de départ
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists programs_owner_idx on public.programs (owner);
alter table public.programs enable row level security;

drop policy if exists "lecture"      on public.programs;
drop policy if exists "creation"     on public.programs;
drop policy if exists "modification" on public.programs;
drop policy if exists "suppression"  on public.programs;

-- Un étudiant voit ses programmes + ceux que l'admin a publiés. L'admin voit tout.
create policy "lecture" on public.programs for select to authenticated
  using (owner = auth.uid() or published or is_template or public.is_admin());
create policy "creation" on public.programs for insert to authenticated
  with check (owner = auth.uid() or public.is_admin());
create policy "modification" on public.programs for update to authenticated
  using (owner = auth.uid() or public.is_admin())
  with check (owner = auth.uid() or public.is_admin());
create policy "suppression" on public.programs for delete to authenticated
  using (owner = auth.uid() or public.is_admin());

-- Garde-fou : seul l'admin peut changer "published" / "is_template",
-- personne ne peut changer le propriétaire, et updated_at se met à jour seul.
create or replace function public.programs_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if not public.is_admin() then
      new.published := false; new.is_template := false; new.owner := auth.uid();
    end if;
  else
    new.owner := old.owner;
    if not public.is_admin() then
      new.published := old.published; new.is_template := old.is_template;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists programs_guard on public.programs;
create trigger programs_guard before insert or update on public.programs
  for each row execute function public.programs_guard();

-- 3) Te donner le rôle admin ------------------------------------------------
-- Crée d'abord ton compte sur le site, puis lance (en mettant TON pseudo) :
--
--   update public.profiles set role = 'admin' where lower(pseudo) = lower('TonPseudo');
