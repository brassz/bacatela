-- Schema GESTAOEMPRESTIMOSALEX / Empréstimos Imperatriz
-- Tabelas prefixadas para não colidir com outros apps no mesmo projeto.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.gestaoemprestimosalex_app_meta (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  revision BIGINT NOT NULL DEFAULT 0,
  atualizado_em TIMESTAMPTZ,
  atualizado_por TEXT
);

INSERT INTO public.gestaoemprestimosalex_app_meta (id, revision)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.gestaoemprestimosalex_users (
  id UUID PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'socio', 'funcionario')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cidades_ids JSONB DEFAULT NULL
);

ALTER TABLE public.gestaoemprestimosalex_users
  ADD COLUMN IF NOT EXISTS cidades_ids JSONB DEFAULT NULL;

CREATE TABLE IF NOT EXISTS public.gestaoemprestimosalex_cidades (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL UNIQUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.gestaoemprestimosalex_clientes ADD COLUMN IF NOT EXISTS cidade_id TEXT;

CREATE TABLE IF NOT EXISTS public.gestaoemprestimosalex_clientes (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  tel TEXT,
  doc TEXT,
  endereco TEXT,
  obs TEXT,
  responsavel TEXT,
  usuario_responsavel TEXT,
  papel_responsavel TEXT,
  unidade TEXT,
  criado_em DATE,
  criado_hora TEXT
);

CREATE TABLE IF NOT EXISTS public.gestaoemprestimosalex_emprestimos (
  id TEXT PRIMARY KEY,
  cliente_id TEXT NOT NULL REFERENCES public.gestaoemprestimosalex_clientes (id) ON DELETE RESTRICT,
  principal NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total NUMERIC(14, 2) NOT NULL DEFAULT 0,
  freq TEXT NOT NULL,
  primeiro_vencimento DATE,
  criado_em DATE,
  data_quitacao DATE,
  renovado_em DATE
);

ALTER TABLE public.gestaoemprestimosalex_emprestimos ADD COLUMN IF NOT EXISTS pasta TEXT;
ALTER TABLE public.gestaoemprestimosalex_emprestimos ADD COLUMN IF NOT EXISTS historico JSONB;

CREATE INDEX IF NOT EXISTS gestaoemprestimosalex_emprestimos_cliente_idx
  ON public.gestaoemprestimosalex_emprestimos (cliente_id);

CREATE TABLE IF NOT EXISTS public.gestaoemprestimosalex_parcelas (
  id TEXT PRIMARY KEY,
  emprestimo_id TEXT NOT NULL REFERENCES public.gestaoemprestimosalex_emprestimos (id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  valor NUMERIC(14, 2) NOT NULL,
  vencimento DATE NOT NULL
);

CREATE INDEX IF NOT EXISTS gestaoemprestimosalex_parcelas_emp_idx
  ON public.gestaoemprestimosalex_parcelas (emprestimo_id);

CREATE TABLE IF NOT EXISTS public.gestaoemprestimosalex_pagamentos (
  id TEXT PRIMARY KEY,
  emprestimo_id TEXT NOT NULL REFERENCES public.gestaoemprestimosalex_emprestimos (id) ON DELETE CASCADE,
  parcela_id TEXT,
  valor NUMERIC(14, 2) NOT NULL,
  data DATE NOT NULL,
  forma TEXT,
  obs TEXT,
  tipo TEXT
);

CREATE INDEX IF NOT EXISTS gestaoemprestimosalex_pagamentos_emp_idx
  ON public.gestaoemprestimosalex_pagamentos (emprestimo_id);

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

CREATE TABLE IF NOT EXISTS public.gestaoemprestimosalex_sessions (
  token TEXT PRIMARY KEY,
  user_json JSONB NOT NULL,
  expira TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS gestaoemprestimosalex_sessions_expira_idx
  ON public.gestaoemprestimosalex_sessions (expira);

CREATE TABLE IF NOT EXISTS public.gestaoemprestimosalex_verificacoes (
  id UUID PRIMARY KEY,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  nome TEXT NOT NULL,
  telefone TEXT,
  endereco TEXT,
  cpf TEXT,
  rg TEXT,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'aprovado', 'rejeitado')),
  observacao TEXT,
  cliente_id TEXT
);

CREATE TABLE IF NOT EXISTS public.gestaoemprestimosalex_verificacao_arquivos (
  id UUID PRIMARY KEY,
  verificacao_id UUID NOT NULL REFERENCES public.gestaoemprestimosalex_verificacoes (id) ON DELETE CASCADE,
  campo TEXT NOT NULL,
  nome TEXT,
  mime TEXT,
  storage_path TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS gestaoemprestimosalex_verif_arq_idx
  ON public.gestaoemprestimosalex_verificacao_arquivos (verificacao_id);

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'gestaoemprestimosalex-documentos',
  'gestaoemprestimosalex-documentos',
  FALSE,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']
)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.gestaoemprestimosalex_ler_estado()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'revision', COALESCE((SELECT revision FROM gestaoemprestimosalex_app_meta WHERE id = 1), 0),
    'atualizadoEm', (SELECT atualizado_em FROM gestaoemprestimosalex_app_meta WHERE id = 1),
    'atualizadoPor', (SELECT atualizado_por FROM gestaoemprestimosalex_app_meta WHERE id = 1),
    'data', jsonb_build_object(
      'clientes', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', c.id,
          'nome', c.nome,
          'tel', c.tel,
          'doc', c.doc,
          'end', c.endereco,
          'obs', c.obs,
          'responsavel', c.responsavel,
          'usuarioResponsavel', c.usuario_responsavel,
          'papelResponsavel', c.papel_responsavel,
          'unidade', c.unidade,
          'cidadeId', c.cidade_id,
          'criadoEm', c.criado_em,
          'criadoHora', c.criado_hora
        ) ORDER BY c.criado_em NULLS LAST, c.nome)
        FROM gestaoemprestimosalex_clientes c
      ), '[]'::jsonb),
      'cidades', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', z.id, 'nome', z.nome) ORDER BY z.nome)
        FROM gestaoemprestimosalex_cidades z
      ), '[]'::jsonb),
      'emprestimos', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', e.id,
          'clienteId', e.cliente_id,
          'principal', e.principal,
          'total', e.total,
          'freq', e.freq,
          'primeiroVencimento', e.primeiro_vencimento,
          'criadoEm', e.criado_em,
          'dataQuitacao', e.data_quitacao,
          'renovadoEm', e.renovado_em,
          'parcelas', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'id', p.id,
              'n', p.n,
              'valor', p.valor,
              'data', p.vencimento
            ) ORDER BY p.n)
            FROM gestaoemprestimosalex_parcelas p
            WHERE p.emprestimo_id = e.id
          ), '[]'::jsonb)
        ) ORDER BY e.criado_em NULLS LAST)
        FROM gestaoemprestimosalex_emprestimos e
      ), '[]'::jsonb),
      'pagamentos', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', g.id,
          'empId', g.emprestimo_id,
          'parcId', g.parcela_id,
          'valor', g.valor,
          'data', g.data,
          'forma', g.forma,
          'obs', g.obs,
          'tipo', g.tipo
        ) ORDER BY g.data)
        FROM gestaoemprestimosalex_pagamentos g
      ), '[]'::jsonb),
      'despesas', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', d.id,
          'descricao', d.descricao,
          'valor', d.valor,
          'data', d.data,
          'cidadeId', d.cidade_id,
          'obs', d.obs,
          'criadoEm', d.criado_em
        ) ORDER BY d.data DESC, d.descricao)
        FROM gestaoemprestimosalex_despesas d
      ), '[]'::jsonb)
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.gestaoemprestimosalex_salvar_estado(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rev BIGINT;
  v_data JSONB;
  v_cli JSONB;
  v_emp JSONB;
  v_pag JSONB;
  v_cid JSONB;
  v_desp JSONB;
BEGIN
  INSERT INTO gestaoemprestimosalex_app_meta (id, revision) VALUES (1, 0)
  ON CONFLICT (id) DO NOTHING;

  SELECT revision INTO v_rev FROM gestaoemprestimosalex_app_meta WHERE id = 1 FOR UPDATE;
  IF (p_payload->>'revision')::BIGINT IS DISTINCT FROM v_rev THEN
    RAISE EXCEPTION 'revision_conflict' USING ERRCODE = 'P0001';
  END IF;

  v_data := COALESCE(p_payload->'data', '{}'::jsonb);
  v_cli := COALESCE(v_data->'clientes', '[]'::jsonb);
  v_emp := COALESCE(v_data->'emprestimos', '[]'::jsonb);
  v_pag := COALESCE(v_data->'pagamentos', '[]'::jsonb);
  v_cid := COALESCE(v_data->'cidades', '[]'::jsonb);
  v_desp := COALESCE(v_data->'despesas', '[]'::jsonb);

  IF jsonb_array_length(v_cid) > 0 OR v_data ? 'cidades' THEN
    DELETE FROM gestaoemprestimosalex_cidades z
    WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_cid) x WHERE x->>'id' = z.id
    );
    INSERT INTO gestaoemprestimosalex_cidades (id, nome)
    SELECT x->>'id', COALESCE(x->>'nome', '')
    FROM jsonb_array_elements(v_cid) x
    WHERE COALESCE(x->>'id', '') <> '' AND COALESCE(x->>'nome', '') <> ''
    ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome;
  END IF;

  DELETE FROM gestaoemprestimosalex_despesas d
  WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_desp) x WHERE x->>'id' = d.id
  );

  INSERT INTO gestaoemprestimosalex_despesas (id, descricao, valor, data, cidade_id, obs, criado_em)
  SELECT
    x->>'id',
    COALESCE(x->>'descricao', ''),
    COALESCE((x->>'valor')::NUMERIC, 0),
    (x->>'data')::DATE,
    NULLIF(x->>'cidadeId', ''),
    x->>'obs',
    NULLIF(x->>'criadoEm', '')::DATE
  FROM jsonb_array_elements(v_desp) x
  WHERE COALESCE(x->>'id', '') <> ''
  ON CONFLICT (id) DO UPDATE SET
    descricao = EXCLUDED.descricao,
    valor = EXCLUDED.valor,
    data = EXCLUDED.data,
    cidade_id = EXCLUDED.cidade_id,
    obs = EXCLUDED.obs,
    criado_em = EXCLUDED.criado_em;

  DELETE FROM gestaoemprestimosalex_pagamentos g
  WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_pag) x WHERE x->>'id' = g.id
  );

  DELETE FROM gestaoemprestimosalex_parcelas p
  WHERE NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_emp) e
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e->'parcelas', '[]'::jsonb)) x
    WHERE x->>'id' = p.id
  );

  DELETE FROM gestaoemprestimosalex_emprestimos e
  WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_emp) x WHERE x->>'id' = e.id
  );

  DELETE FROM gestaoemprestimosalex_clientes c
  WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_cli) x WHERE x->>'id' = c.id
  );

  INSERT INTO gestaoemprestimosalex_clientes (
    id, nome, tel, doc, endereco, obs, responsavel, usuario_responsavel, papel_responsavel, unidade, cidade_id, criado_em, criado_hora
  )
  SELECT
    x->>'id',
    COALESCE(x->>'nome', ''),
    x->>'tel',
    x->>'doc',
    x->>'end',
    x->>'obs',
    x->>'responsavel',
    x->>'usuarioResponsavel',
    x->>'papelResponsavel',
    x->>'unidade',
    NULLIF(x->>'cidadeId', ''),
    NULLIF(x->>'criadoEm', '')::DATE,
    x->>'criadoHora'
  FROM jsonb_array_elements(v_cli) x
  ON CONFLICT (id) DO UPDATE SET
    nome = EXCLUDED.nome,
    tel = EXCLUDED.tel,
    doc = EXCLUDED.doc,
    endereco = EXCLUDED.endereco,
    obs = EXCLUDED.obs,
    responsavel = EXCLUDED.responsavel,
    usuario_responsavel = EXCLUDED.usuario_responsavel,
    papel_responsavel = EXCLUDED.papel_responsavel,
    unidade = EXCLUDED.unidade,
    cidade_id = EXCLUDED.cidade_id,
    criado_em = EXCLUDED.criado_em,
    criado_hora = EXCLUDED.criado_hora;

  INSERT INTO gestaoemprestimosalex_emprestimos (
    id, cliente_id, principal, total, freq, primeiro_vencimento, criado_em, data_quitacao, renovado_em
  )
  SELECT
    x->>'id',
    x->>'clienteId',
    COALESCE((x->>'principal')::NUMERIC, 0),
    COALESCE((x->>'total')::NUMERIC, 0),
    COALESCE(x->>'freq', 'weekly'),
    NULLIF(x->>'primeiroVencimento', '')::DATE,
    NULLIF(x->>'criadoEm', '')::DATE,
    NULLIF(x->>'dataQuitacao', '')::DATE,
    NULLIF(x->>'renovadoEm', '')::DATE
  FROM jsonb_array_elements(v_emp) x
  ON CONFLICT (id) DO UPDATE SET
    cliente_id = EXCLUDED.cliente_id,
    principal = EXCLUDED.principal,
    total = EXCLUDED.total,
    freq = EXCLUDED.freq,
    primeiro_vencimento = EXCLUDED.primeiro_vencimento,
    criado_em = EXCLUDED.criado_em,
    data_quitacao = EXCLUDED.data_quitacao,
    renovado_em = EXCLUDED.renovado_em;

  INSERT INTO gestaoemprestimosalex_parcelas (id, emprestimo_id, n, valor, vencimento)
  SELECT
    p->>'id',
    e->>'id',
    COALESCE((p->>'n')::INT, 1),
    COALESCE((p->>'valor')::NUMERIC, 0),
    (p->>'data')::DATE
  FROM jsonb_array_elements(v_emp) e
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e->'parcelas', '[]'::jsonb)) p
  ON CONFLICT (id) DO UPDATE SET
    emprestimo_id = EXCLUDED.emprestimo_id,
    n = EXCLUDED.n,
    valor = EXCLUDED.valor,
    vencimento = EXCLUDED.vencimento;

  INSERT INTO gestaoemprestimosalex_pagamentos (id, emprestimo_id, parcela_id, valor, data, forma, obs, tipo)
  SELECT
    x->>'id',
    x->>'empId',
    NULLIF(x->>'parcId', ''),
    COALESCE((x->>'valor')::NUMERIC, 0),
    (x->>'data')::DATE,
    x->>'forma',
    x->>'obs',
    x->>'tipo'
  FROM jsonb_array_elements(v_pag) x
  ON CONFLICT (id) DO UPDATE SET
    emprestimo_id = EXCLUDED.emprestimo_id,
    parcela_id = EXCLUDED.parcela_id,
    valor = EXCLUDED.valor,
    data = EXCLUDED.data,
    forma = EXCLUDED.forma,
    obs = EXCLUDED.obs,
    tipo = EXCLUDED.tipo;

  UPDATE gestaoemprestimosalex_app_meta
  SET
    revision = v_rev + 1,
    atualizado_em = NOW(),
    atualizado_por = p_payload->>'atualizadoPor'
  WHERE id = 1;

  RETURN jsonb_build_object('ok', TRUE, 'revision', v_rev + 1);
END;
$$;

GRANT EXECUTE ON FUNCTION public.gestaoemprestimosalex_ler_estado() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gestaoemprestimosalex_salvar_estado(jsonb) TO anon, authenticated;

ALTER TABLE public.gestaoemprestimosalex_app_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gestaoemprestimosalex_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gestaoemprestimosalex_cidades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gestaoemprestimosalex_clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gestaoemprestimosalex_emprestimos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gestaoemprestimosalex_parcelas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gestaoemprestimosalex_pagamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gestaoemprestimosalex_despesas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gestaoemprestimosalex_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gestaoemprestimosalex_verificacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gestaoemprestimosalex_verificacao_arquivos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gestaoemprestimosalex_app_meta_all ON public.gestaoemprestimosalex_app_meta;
DROP POLICY IF EXISTS gestaoemprestimosalex_users_all ON public.gestaoemprestimosalex_users;
DROP POLICY IF EXISTS gestaoemprestimosalex_cidades_all ON public.gestaoemprestimosalex_cidades;
DROP POLICY IF EXISTS gestaoemprestimosalex_clientes_all ON public.gestaoemprestimosalex_clientes;
DROP POLICY IF EXISTS gestaoemprestimosalex_emprestimos_all ON public.gestaoemprestimosalex_emprestimos;
DROP POLICY IF EXISTS gestaoemprestimosalex_parcelas_all ON public.gestaoemprestimosalex_parcelas;
DROP POLICY IF EXISTS gestaoemprestimosalex_pagamentos_all ON public.gestaoemprestimosalex_pagamentos;
DROP POLICY IF EXISTS gestaoemprestimosalex_despesas_all ON public.gestaoemprestimosalex_despesas;
DROP POLICY IF EXISTS gestaoemprestimosalex_sessions_all ON public.gestaoemprestimosalex_sessions;
DROP POLICY IF EXISTS gestaoemprestimosalex_verificacoes_all ON public.gestaoemprestimosalex_verificacoes;
DROP POLICY IF EXISTS gestaoemprestimosalex_verificacao_arquivos_all ON public.gestaoemprestimosalex_verificacao_arquivos;

CREATE POLICY gestaoemprestimosalex_app_meta_all ON public.gestaoemprestimosalex_app_meta FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY gestaoemprestimosalex_users_all ON public.gestaoemprestimosalex_users FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY gestaoemprestimosalex_cidades_all ON public.gestaoemprestimosalex_cidades FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY gestaoemprestimosalex_clientes_all ON public.gestaoemprestimosalex_clientes FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY gestaoemprestimosalex_emprestimos_all ON public.gestaoemprestimosalex_emprestimos FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY gestaoemprestimosalex_parcelas_all ON public.gestaoemprestimosalex_parcelas FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY gestaoemprestimosalex_pagamentos_all ON public.gestaoemprestimosalex_pagamentos FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY gestaoemprestimosalex_despesas_all ON public.gestaoemprestimosalex_despesas FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY gestaoemprestimosalex_sessions_all ON public.gestaoemprestimosalex_sessions FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY gestaoemprestimosalex_verificacoes_all ON public.gestaoemprestimosalex_verificacoes FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY gestaoemprestimosalex_verificacao_arquivos_all ON public.gestaoemprestimosalex_verificacao_arquivos FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS gestaoemprestimosalex_storage_insert ON storage.objects;
DROP POLICY IF EXISTS gestaoemprestimosalex_storage_select ON storage.objects;
DROP POLICY IF EXISTS gestaoemprestimosalex_storage_update ON storage.objects;
DROP POLICY IF EXISTS gestaoemprestimosalex_storage_delete ON storage.objects;

CREATE POLICY gestaoemprestimosalex_storage_insert ON storage.objects FOR INSERT TO anon
  WITH CHECK (bucket_id = 'gestaoemprestimosalex-documentos');
CREATE POLICY gestaoemprestimosalex_storage_select ON storage.objects FOR SELECT TO anon
  USING (bucket_id = 'gestaoemprestimosalex-documentos');
CREATE POLICY gestaoemprestimosalex_storage_update ON storage.objects FOR UPDATE TO anon
  USING (bucket_id = 'gestaoemprestimosalex-documentos') WITH CHECK (bucket_id = 'gestaoemprestimosalex-documentos');
CREATE POLICY gestaoemprestimosalex_storage_delete ON storage.objects FOR DELETE TO anon
  USING (bucket_id = 'gestaoemprestimosalex-documentos');
