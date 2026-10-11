-- =====================================================================
--  Pseudo-Lab — MIGRATION « projets + permissions »
--  À coller UNE FOIS dans Supabase › SQL Editor › New query › Run
--  (sans danger si on la relance : tout est « if not exists » / « or replace »)
--  Le même contenu est inclus à la fin de schema.sql pour les nouvelles installations.
-- =====================================================================

-- 1) Permissions de chaque étudiant (réglées par l'admin) ------------------
alter table public.profiles add column if not exists can_run         boolean not null default true;  -- peut exécuter
alter table public.profiles add column if not exists can_free        boolean not null default true;  -- peut enregistrer hors projets
alter table public.profiles add column if not exists can_view_others boolean not null default true;  -- peut voir le travail des autres (si le projet le permet)

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
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.projects enable row level security;
drop policy if exists "projets lisibles" on public.projects;
create policy "projets lisibles" on public.projects for select to authenticated using (true);
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
-- « puis-je voir le travail des autres dans ce projet ? » = réglage du projet ET de mon compte
create or replace function public.can_see_work(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select pid is not null
    and coalesce((select share_work from public.projects where id = pid), false)
    and coalesce((select can_view_others from public.profiles where id = auth.uid()), false);
$$;

drop policy if exists "lecture"      on public.programs;
drop policy if exists "creation"     on public.programs;
drop policy if exists "modification" on public.programs;
create policy "lecture" on public.programs for select to authenticated
  using (owner = auth.uid() or published or is_template or public.is_admin() or public.can_see_work(project_id));
create policy "creation" on public.programs for insert to authenticated
  with check (public.is_admin() or (owner = auth.uid() and (project_id is not null or public.can_free())));
create policy "modification" on public.programs for update to authenticated
  using (owner = auth.uid() or public.is_admin())
  with check (public.is_admin() or (owner = auth.uid() and (project_id is not null or public.can_free())));

-- Garde-fou (remplace l'ancien) : un étudiant ne peut pas déplacer un programme d'un projet à l'autre
-- ni renommer son travail de projet.
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
      new.published := old.published; new.is_template := old.is_template; new.project_id := old.project_id;
    end if;
  end if;
  -- le travail d'un étudiant dans un projet porte toujours le titre et le TD du projet (il ne peut pas les changer)
  if not public.is_admin() and new.project_id is not null then
    select p.title, p.td into new.title, new.td from public.projects p where p.id = new.project_id;
  end if;
  new.updated_at := now();
  return new;
end $$;
