ALTER TABLE public.gestaoemprestimosalex_emprestimos ADD COLUMN IF NOT EXISTS pasta TEXT;
ALTER TABLE public.gestaoemprestimosalex_emprestimos ADD COLUMN IF NOT EXISTS historico JSONB;
