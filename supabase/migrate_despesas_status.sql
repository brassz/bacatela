-- Adiciona status de pagamento e valor pago às despesas
ALTER TABLE public.gestaoemprestimosalex_despesas
  ADD COLUMN IF NOT EXISTS status_pagamento TEXT DEFAULT 'pendente';

ALTER TABLE public.gestaoemprestimosalex_despesas
  ADD COLUMN IF NOT EXISTS valor_pago NUMERIC(14, 2) DEFAULT 0;
