CREATE TABLE IF NOT EXISTS public.gestaoemprestimosalex_despesas (
  id TEXT PRIMARY KEY,
  descricao TEXT NOT NULL,
  valor NUMERIC(14, 2) NOT NULL DEFAULT 0,
  data DATE NOT NULL,
  cidade_id TEXT,
  obs TEXT,
  criado_em DATE
);

CREATE INDEX IF NOT EXISTS gestaoemprestimosalex_despesas_data_idx
  ON public.gestaoemprestimosalex_despesas (data);

ALTER TABLE public.gestaoemprestimosalex_despesas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gestaoemprestimosalex_despesas_all ON public.gestaoemprestimosalex_despesas;
CREATE POLICY gestaoemprestimosalex_despesas_all ON public.gestaoemprestimosalex_despesas FOR ALL TO anon USING (true) WITH CHECK (true);
