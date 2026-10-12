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

-- =====================================================================
--  4) Projets et permissions (identique à migration-projets.sql)
-- =====================================================================
-- 1) Permissions de chaque étudiant (réglées par l'admin) ------------------
alter table public.profiles add column if not exists can_run         boolean not null default true;  -- peut exécuter
alter table public.profiles add column if not exists can_free        boolean not null default true;  -- peut enregistrer hors projets
alter table public.profiles add column if not exists can_view_others boolean not null default true;  -- peut voir le travail des autres (si le projet le permet)
alter table public.profiles add column if not exists run_unlimited   boolean not null default false; -- exécution illimitée : ignore tous les blocages d'exécution

drop policy if exists "profils modifiables par l'admin" on public.profiles;
create policy "profils modifiables par l'admin" on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Le rôle (student/admin) ne se change jamais depuis le site, seulement depuis cet éditeur SQL.
create or replace function public.profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.id := old.id;
  if auth.uid() is not null then new.role := old.role; end if;
  return new;
end $$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.profiles_guard();

-- 2) Réglages globaux (une seule ligne) ------------------------------------
create table if not exists public.settings (
  id            int primary key default 1 check (id = 1),
  run_enabled   boolean not null default true,   -- exécution autorisée pour tous
  free_programs boolean not null default true,   -- programmes libres (hors projets) autorisés
  updated_at    timestamptz not null default now()
);
alter table public.settings add column if not exists delete_project_work boolean not null default false; -- les étudiants peuvent supprimer leur travail de projet
insert into public.settings (id) values (1) on conflict (id) do nothing;
alter table public.settings enable row level security;
drop policy if exists "reglages lisibles" on public.settings;
create policy "reglages lisibles" on public.settings for select to anon, authenticated using (true);
drop policy if exists "reglages admin" on public.settings;
create policy "reglages admin" on public.settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- 3) Projets (exercices créés par l'admin) ---------------------------------
create table if not exists public.projects (
  id           uuid primary key default gen_random_uuid(),
  title        text not null default 'Projet',
  td           text not null default '',
  instructions text not null default '',        -- consigne
  starter_code text not null default '',        -- code de départ donné aux étudiants
  run_enabled  boolean not null default true,   -- exécution autorisée dans ce projet
  share_work   boolean not null default false,  -- les étudiants voient le travail des autres
  visible      boolean not null default true,   -- visible par les étudiants (décoché = en préparation)
  hidden_for   uuid[]  not null default '{}',   -- étudiants pour qui le projet reste invisible
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.projects add column if not exists visible    boolean not null default true;
alter table public.projects add column if not exists hidden_for uuid[]  not null default '{}';
alter table public.projects enable row level security;

-- « ce projet est-il ouvert pour moi ? » = visible ET je ne suis pas dans la liste des masqués (l'admin voit tout)
create or replace function public.can_use_project(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (
    select 1 from public.projects p where p.id = pid and p.visible and not (auth.uid() = any(p.hidden_for)));
$$;
drop policy if exists "projets lisibles" on public.projects;
create policy "projets lisibles" on public.projects for select to authenticated
  using (public.is_admin() or (visible and not (auth.uid() = any(hidden_for))));
drop policy if exists "projets admin" on public.projects;
create policy "projets admin" on public.projects for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists projects_touch on public.projects;
create trigger projects_touch before update on public.projects
  for each row execute function public.touch_updated_at();

-- 4) Le travail d'un étudiant dans un projet = un programme avec project_id ---
alter table public.programs add column if not exists project_id uuid references public.projects(id) on delete set null;
create unique index if not exists programs_one_per_project on public.programs (owner, project_id) where project_id is not null;

-- « puis-je enregistrer hors projet ? » = réglage global ET réglage de mon compte
create or replace function public.can_free() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or (
    coalesce((select free_programs from public.settings where id = 1), true)
    and coalesce((select can_free from public.profiles where id = auth.uid()), false));
$$;
-- 5) Rendu « J'ai fini » et essais (versions) -------------------------------
alter table public.projects add column if not exists submit_mode      boolean not null default false; -- bouton « J'ai fini »
alter table public.projects add column if not exists run_after_submit boolean not null default false; -- exécution seulement après « J'ai fini »
alter table public.projects add column if not exists max_attempts     int     not null default 1;     -- nombre de rendus permis
alter table public.programs add column if not exists submitted_at   timestamptz;                       -- rempli = rendu, donc verrouillé
alter table public.programs add column if not exists attempts       int   not null default 0;          -- nombre de rendus déjà faits
alter table public.programs add column if not exists extra_attempts int   not null default 0;          -- essais en plus donnés par l'admin
alter table public.programs add column if not exists versions       jsonb not null default '[]'::jsonb; -- copie de chaque version rendue

alter table public.programs add column if not exists final_at timestamptz;   -- rendu définitif (l'étudiant renonce à ses essais restants)

-- « puis-je voir le travail des autres dans ce projet ? » = réglage du projet ET de mon compte,
-- et, dans un projet « J'ai fini », seulement quand mon travail est terminé (rendu définitif ou plus d'essai)
create or replace function public.can_see_work(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select pid is not null
    and public.can_use_project(pid)
    and coalesce((select share_work from public.projects where id = pid), false)
    and coalesce((select can_view_others from public.profiles where id = auth.uid()), false)
    and (not coalesce((select submit_mode from public.projects where id = pid), false)
      or exists (select 1 from public.programs w join public.projects p on p.id = w.project_id
                 where w.project_id = pid and w.owner = auth.uid() and w.submitted_at is not null
                   and (w.final_at is not null or w.attempts >= p.max_attempts + w.extra_attempts)));
$$;

drop policy if exists "lecture"      on public.programs;
drop policy if exists "creation"     on public.programs;
drop policy if exists "modification" on public.programs;
create policy "lecture" on public.programs for select to authenticated
  using (owner = auth.uid() or published or is_template or public.is_admin() or public.can_see_work(project_id));
-- un étudiant n'enregistre que dans un projet ouvert pour lui, ou hors projet s'il a droit aux programmes libres
create policy "creation" on public.programs for insert to authenticated
  with check (public.is_admin() or (owner = auth.uid() and
    (case when project_id is null then public.can_free() else public.can_use_project(project_id) end)));
-- suppression : un étudiant supprime ses programmes libres ; son travail de projet seulement si l'admin l'autorise
-- (sinon il pourrait supprimer puis recommencer pour retrouver des essais)
drop policy if exists "suppression" on public.programs;
create policy "suppression" on public.programs for delete to authenticated
  using (public.is_admin() or (owner = auth.uid() and
    (project_id is null or coalesce((select delete_project_work from public.settings where id = 1), false))));
create policy "modification" on public.programs for update to authenticated
  using (owner = auth.uid() or public.is_admin())
  with check (public.is_admin() or (owner = auth.uid() and
    (case when project_id is null then public.can_free() else public.can_use_project(project_id) end)));

-- Garde-fou (remplace l'ancien) : un étudiant ne peut pas déplacer un programme d'un projet à l'autre,
-- ni renommer son travail de projet, ni modifier un travail rendu ; « nouvel essai » seulement s'il en reste.
create or replace function public.programs_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  is_adm  boolean := public.is_admin();
  allowed int;
begin
  if tg_op = 'INSERT' then
    if not is_adm then
      new.published := false; new.is_template := false; new.owner := auth.uid();
      new.submitted_at := null; new.final_at := null; new.attempts := 0; new.extra_attempts := 0; new.versions := '[]'::jsonb;
    end if;
  else
    new.owner := old.owner;
    if not is_adm then
      new.published := old.published; new.is_template := old.is_template; new.project_id := old.project_id;
      new.attempts := old.attempts; new.extra_attempts := old.extra_attempts; new.versions := old.versions;
      -- « Rendu définitif » : seulement sur un travail rendu, et sans retour en arrière
      if old.final_at is null and new.final_at is not null and old.submitted_at is not null then
        new.final_at := now();
      else
        new.final_at := old.final_at;
      end if;
      if old.submitted_at is not null then
        if new.submitted_at is null then
          -- « Nouvel essai » : seulement s'il lui en reste et s'il n'a pas confirmé son rendu définitif
          if old.final_at is not null then
            raise exception 'Tu as confirmé ton rendu définitif : demande à ton prof pour le rouvrir.';
          end if;
          select max_attempts into allowed from public.projects where id = old.project_id;
          if old.attempts >= coalesce(allowed, 1) + old.extra_attempts then
            raise exception 'Plus d''essai disponible pour ce projet : demande à ton prof.';
          end if;
        else
          -- travail rendu : verrouillé
          new.code := old.code; new.submitted_at := old.submitted_at;
        end if;
      end if;
    end if;
    -- « J'ai fini » : heure du rendu, un essai de plus, et une copie de la version rendue
    if old.submitted_at is null and new.submitted_at is not null then
      new.submitted_at := now();
      new.attempts := old.attempts + 1;
      new.versions := old.versions || jsonb_build_array(jsonb_build_object('n', old.attempts + 1, 'code', new.code, 'at', now()));
    end if;
  end if;
  -- le travail d'un étudiant dans un projet porte toujours le titre et le TD du projet (il ne peut pas les changer)
  if not is_adm and new.project_id is not null then
    select p.title, p.td into new.title, new.td from public.projects p where p.id = new.project_id;
  end if;
  new.updated_at := now();
  return new;
end $$;
