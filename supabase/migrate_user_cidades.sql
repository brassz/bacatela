-- Permite vincular cidades de acesso por usuário (aba Acessos).
ALTER TABLE public.gestaoemprestimosalex_users
  ADD COLUMN IF NOT EXISTS cidades_ids JSONB DEFAULT NULL;

-- Atualiza o cache do PostgREST para a API enxergar a coluna nova.
NOTIFY pgrst, 'reload schema';
