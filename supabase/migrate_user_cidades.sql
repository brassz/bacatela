ALTER TABLE public.gestaoemprestimosalex_users
  ADD COLUMN IF NOT EXISTS cidades_ids JSONB DEFAULT NULL;
