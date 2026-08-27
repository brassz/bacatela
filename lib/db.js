'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null) process.env[k] = v;
  }
}
loadEnv();

function supabaseUrl() {
  return String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim().replace(/\/$/, '');
}
function supabaseKey() {
  return String(
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_SERVICE_ROLE ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    ''
  ).trim();
}
const BUCKET = 'gestaoemprestimosalex-documentos';

function headers(extra = {}) {
  return {
    apikey: supabaseKey(),
    Authorization: 'Bearer ' + supabaseKey(),
    ...extra
  };
}

async function rest(method, urlPath, body, extraHeaders = {}) {
  const base = supabaseUrl();
  const key = supabaseKey();
  if (!base || !key) {
    throw new Error('SUPABASE_URL ou SUPABASE_ANON_KEY vazias neste processo. Na Vercel, marque as variáveis para Production e Preview e faça Redeploy.');
  }
  const r = await fetch(base + urlPath, {
    method,
    headers: headers({
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...extraHeaders
    }),
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const msg = (data && (data.message || data.error_description || data.erro || data.hint)) || text || ('HTTP ' + r.status);
    const err = new Error(msg);
    err.status = r.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function rpc(name, args) {
  return rest('POST', '/rest/v1/rpc/' + name, args || {});
}

function rpcMissing(e) {
  const m = String(e && e.message || '');
  return e && (e.status === 404 || e.status === 400) && /Could not find the function|PGRST202/i.test(m);
}

async function restAll(table, select) {
  const out = [];
  const page = 1000;
  let from = 0;
  for (;;) {
    const rows = await rest(
      'GET',
      '/rest/v1/' + table + '?select=' + encodeURIComponent(select) + '&limit=' + page + '&offset=' + from
    );
    const arr = Array.isArray(rows) ? rows : [];
    out.push(...arr);
    if (arr.length < page) break;
    from += page;
  }
  return out;
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

async function readDbRest() {
  const [metaRows, clientes, cidades, emprestimos, parcelas, pagamentos, despesas] = await Promise.all([
    rest('GET', '/rest/v1/gestaoemprestimosalex_app_meta?select=revision,atualizado_em,atualizado_por&id=eq.1'),
    restAll('gestaoemprestimosalex_clientes', '*'),
    restAll('gestaoemprestimosalex_cidades', 'id,nome'),
    restAll('gestaoemprestimosalex_emprestimos', '*'),
    restAll('gestaoemprestimosalex_parcelas', '*'),
    restAll('gestaoemprestimosalex_pagamentos', '*'),
    restAll('gestaoemprestimosalex_despesas', '*').catch(() => [])
  ]);
  const meta = Array.isArray(metaRows) ? metaRows[0] : null;
  const parsPorEmp = new Map();
  for (const p of parcelas) {
    const eid = p.emprestimo_id;
    if (!parsPorEmp.has(eid)) parsPorEmp.set(eid, []);
    parsPorEmp.get(eid).push({
      id: p.id,
      n: n(p.n),
      valor: n(p.valor),
      data: p.vencimento
    });
  }
  for (const list of parsPorEmp.values()) list.sort((a, b) => a.n - b.n);
  return {
    revision: meta && meta.revision != null ? Number(meta.revision) : 0,
    atualizadoEm: meta && meta.atualizado_em,
    atualizadoPor: meta && meta.atualizado_por,
    data: {
      clientes: clientes.map(c => ({
        id: c.id,
        nome: c.nome,
        tel: c.tel,
        doc: c.doc,
        end: c.endereco,
        obs: c.obs,
        responsavel: c.responsavel,
        usuarioResponsavel: c.usuario_responsavel,
        papelResponsavel: c.papel_responsavel,
        unidade: c.unidade,
        cidadeId: c.cidade_id,
        criadoEm: c.criado_em,
        criadoHora: c.criado_hora
      })),
      cidades: cidades.map(z => ({ id: z.id, nome: z.nome })),
      emprestimos: emprestimos.map(e => ({
        id: e.id,
        clienteId: e.cliente_id,
        principal: n(e.principal),
        total: n(e.total),
        freq: e.freq,
        primeiroVencimento: e.primeiro_vencimento,
        criadoEm: e.criado_em,
        dataQuitacao: e.data_quitacao,
        renovadoEm: e.renovado_em,
        pasta: e.pasta || undefined,
        historico: Array.isArray(e.historico) ? e.historico : (e.historico ? e.historico : []),
        parcelas: parsPorEmp.get(e.id) || []
      })),
      pagamentos: pagamentos.map(g => ({
        id: g.id,
        empId: g.emprestimo_id,
        parcId: g.parcela_id,
        valor: n(g.valor),
        data: g.data,
        forma: g.forma,
        obs: g.obs,
        tipo: g.tipo
      })),
      despesas: (Array.isArray(despesas) ? despesas : []).map(d => ({
        id: d.id,
        descricao: d.descricao,
        valor: n(d.valor),
        data: d.data,
        cidadeId: d.cidade_id || null,
        obs: d.obs || '',
        criadoEm: d.criado_em
      }))
    }
  };
}

async function deleteMissing(table, idCol, keepIds) {
  const rows = await restAll(table, idCol);
  const keep = new Set(keepIds.map(String));
  const gone = rows.map(r => r[idCol]).filter(id => !keep.has(String(id)));
  for (const id of gone) {
    await rest('DELETE', '/rest/v1/' + table + '?' + idCol + '=eq.' + encodeURIComponent(id));
  }
}

async function writeDbRest(next) {
  const data = next.data || {};
  const cli = Array.isArray(data.clientes) ? data.clientes : [];
  const emp = Array.isArray(data.emprestimos) ? data.emprestimos : [];
  const pag = Array.isArray(data.pagamentos) ? data.pagamentos : [];
  const cid = Array.isArray(data.cidades) ? data.cidades : [];
  const desp = Array.isArray(data.despesas) ? data.despesas : [];
  const pars = [];
  for (const e of emp) {
    for (const p of e.parcelas || []) {
      if (!p || !p.id) continue;
      pars.push({
        id: p.id,
        emprestimo_id: e.id,
        n: n(p.n) || 1,
        valor: n(p.valor),
        vencimento: p.data
      });
    }
  }

  const metaRows = await rest('GET', '/rest/v1/gestaoemprestimosalex_app_meta?select=revision&id=eq.1');
  const vRev = Array.isArray(metaRows) && metaRows[0] ? Number(metaRows[0].revision) : 0;
  if (Number(next.revision) !== vRev) throw new Error('revision_conflict');

  await rest('POST', '/rest/v1/gestaoemprestimosalex_app_meta', { id: 1, revision: vRev }, {
    Prefer: 'resolution=merge-duplicates,return=minimal'
  }).catch(() => {});

  if (data.cidades) {
    await deleteMissing('gestaoemprestimosalex_cidades', 'id', cid.map(z => z.id));
    if (cid.length) {
      await rest('POST', '/rest/v1/gestaoemprestimosalex_cidades', cid.map(z => ({
        id: z.id,
        nome: z.nome || ''
      })), { Prefer: 'resolution=merge-duplicates,return=minimal' });
    }
  }

  await deleteMissing('gestaoemprestimosalex_pagamentos', 'id', pag.map(p => p.id));
  await deleteMissing('gestaoemprestimosalex_parcelas', 'id', pars.map(p => p.id));
  await deleteMissing('gestaoemprestimosalex_emprestimos', 'id', emp.map(e => e.id));
  await deleteMissing('gestaoemprestimosalex_clientes', 'id', cli.map(c => c.id));

  if (cli.length) {
    await rest('POST', '/rest/v1/gestaoemprestimosalex_clientes', cli.map(x => ({
      id: x.id,
      nome: x.nome || '',
      tel: x.tel || null,
      doc: x.doc || null,
      endereco: x.end || null,
      obs: x.obs || null,
      responsavel: x.responsavel || null,
      usuario_responsavel: x.usuarioResponsavel || null,
      papel_responsavel: x.papelResponsavel || null,
      unidade: x.unidade || null,
      cidade_id: x.cidadeId || null,
      criado_em: x.criadoEm || null,
      criado_hora: x.criadoHora || null
    })), { Prefer: 'resolution=merge-duplicates,return=minimal' });
  }
  if (emp.length) {
    const rows = emp.map(x => ({
      id: x.id,
      cliente_id: x.clienteId,
      principal: n(x.principal),
      total: n(x.total),
      freq: x.freq || 'weekly',
      primeiro_vencimento: x.primeiroVencimento || null,
      criado_em: x.criadoEm || null,
      data_quitacao: x.dataQuitacao || null,
      renovado_em: x.renovadoEm || null,
      pasta: x.pasta || 'ativo',
      historico: Array.isArray(x.historico) ? x.historico : []
    }));
    try {
      await rest('POST', '/rest/v1/gestaoemprestimosalex_emprestimos', rows, {
        Prefer: 'resolution=merge-duplicates,return=minimal'
      });
    } catch (e) {
      const msg = String(e && e.message || '');
      if (!/pasta|historico|42703/i.test(msg)) throw e;
      await rest('POST', '/rest/v1/gestaoemprestimosalex_emprestimos', rows.map(({ pasta, historico, ...r }) => r), {
        Prefer: 'resolution=merge-duplicates,return=minimal'
      });
    }
  }
  if (pars.length) {
    await rest('POST', '/rest/v1/gestaoemprestimosalex_parcelas', pars, {
      Prefer: 'resolution=merge-duplicates,return=minimal'
    });
  }
  if (pag.length) {
    await rest('POST', '/rest/v1/gestaoemprestimosalex_pagamentos', pag.map(x => ({
      id: x.id,
      emprestimo_id: x.empId,
      parcela_id: x.parcId || null,
      valor: n(x.valor),
      data: x.data,
      forma: x.forma || null,
      obs: x.obs || null,
      tipo: x.tipo || null
    })), { Prefer: 'resolution=merge-duplicates,return=minimal' });
  }

  try {
    await deleteMissing('gestaoemprestimosalex_despesas', 'id', desp.map(d => d.id));
    if (desp.length) {
      await rest('POST', '/rest/v1/gestaoemprestimosalex_despesas', desp.map(x => ({
        id: x.id,
        descricao: x.descricao || '',
        valor: n(x.valor),
        data: x.data,
        cidade_id: x.cidadeId || null,
        obs: x.obs || null,
        criado_em: x.criadoEm || null
      })), { Prefer: 'resolution=merge-duplicates,return=minimal' });
    }
  } catch (e) {
    if (!/gestaoemprestimosalex_despesas|42P01|42703/i.test(String(e.message || ''))) throw e;
  }

  const newRev = vRev + 1;
  await rest('PATCH', '/rest/v1/gestaoemprestimosalex_app_meta?id=eq.1', {
    revision: newRev,
    atualizado_em: new Date().toISOString(),
    atualizado_por: next.atualizadoPor || null
  }, { Prefer: 'return=minimal' });
  return { ok: true, revision: newRev };
}

async function readDb() {
  try {
    const x = await rpc('gestaoemprestimosalex_ler_estado');
    if (!x || !x.data) return { revision: 0, data: { clientes: [], emprestimos: [], pagamentos: [], cidades: [], despesas: [] } };
    x.data.clientes = x.data.clientes || [];
    x.data.emprestimos = x.data.emprestimos || [];
    x.data.pagamentos = x.data.pagamentos || [];
    x.data.cidades = x.data.cidades || [];
    x.data.despesas = x.data.despesas || [];
    return x;
  } catch (e) {
    if (!rpcMissing(e)) throw e;
    return readDbRest();
  }
}

async function writeDb(next) {
  try {
    return await rpc('gestaoemprestimosalex_salvar_estado', { p_payload: next });
  } catch (e) {
    if (String(e.message).includes('revision_conflict')) throw new Error('revision_conflict');
    if (!rpcMissing(e)) throw e;
    return writeDbRest(next);
  }
}

function mapUser(row) {
  let cidadesIds = null;
  if (Array.isArray(row.cidades_ids)) cidadesIds = row.cidades_ids.map(String);
  else if (typeof row.cidades_ids === 'string') {
    try {
      const p = JSON.parse(row.cidades_ids);
      if (Array.isArray(p)) cidadesIds = p.map(String);
    } catch {}
  }
  return {
    id: row.id,
    usuario: row.username,
    nome: row.name,
    papel: row.role,
    ativo: row.active !== false,
    salt: row.salt,
    hash: row.password_hash,
    criadoEm: row.created_at,
    cidadesIds
  };
}

async function readUsers() {
  const rows = await rest('GET', '/rest/v1/gestaoemprestimosalex_users?select=*&order=created_at.asc');
  return Array.isArray(rows) ? rows.map(mapUser) : [];
}

async function writeUsers(arr) {
  const atuais = await readUsers();
  const ids = new Set(arr.map(u => u.id));
  for (const antigo of atuais) {
    if (!ids.has(antigo.id)) {
      await rest('DELETE', '/rest/v1/gestaoemprestimosalex_users?id=eq.' + encodeURIComponent(antigo.id));
    }
  }
  if (!arr.length) return;
  const rows = arr.map(u => ({
    id: u.id,
    username: u.usuario,
    name: u.nome,
    role: u.papel,
    active: u.ativo !== false,
    salt: u.salt,
    password_hash: u.hash,
    created_at: u.criadoEm || new Date().toISOString(),
    cidades_ids: Array.isArray(u.cidadesIds) ? u.cidadesIds.map(String) : null
  }));
  await rest('POST', '/rest/v1/gestaoemprestimosalex_users?on_conflict=id', rows, {
    Prefer: 'resolution=merge-duplicates,return=minimal'
  });
}

async function updateUser(id, patch) {
  const row = {};
  if (typeof patch.nome === 'string') row.name = patch.nome;
  if (typeof patch.usuario === 'string') row.username = patch.usuario;
  if (typeof patch.papel === 'string') row.role = patch.papel;
  if (typeof patch.ativo === 'boolean') row.active = patch.ativo;
  if (patch.salt) row.salt = patch.salt;
  if (patch.hash) row.password_hash = patch.hash;
  if (patch.cidadesIds !== undefined) {
    row.cidades_ids = Array.isArray(patch.cidadesIds) ? patch.cidadesIds.map(String) : null;
  }
  if (!Object.keys(row).length) return null;
  const rows = await rest(
    'PATCH',
    '/rest/v1/gestaoemprestimosalex_users?id=eq.' + encodeURIComponent(id),
    row,
    { Prefer: 'return=representation' }
  );
  const updated = Array.isArray(rows) ? rows[0] : null;
  return updated ? mapUser(updated) : null;
}

async function initUsers(hashSenha) {
  const existentes = await readUsers();
  if (existentes.length) return;
  const adminSenha = process.env.ADMIN_PASSWORD || 'Admin123!';
  const cred = hashSenha(adminSenha);
  const arr = [{
    id: crypto.randomUUID(),
    usuario: process.env.ADMIN_USER || 'admin',
    nome: process.env.ADMIN_NAME || 'Administrador',
    papel: 'admin',
    ativo: true,
    criadoEm: new Date().toISOString(),
    ...cred
  }];
  if (process.env.SOCIO_PASSWORD) {
    const c = hashSenha(process.env.SOCIO_PASSWORD);
    arr.push({
      id: crypto.randomUUID(),
      usuario: process.env.SOCIO_USER || 'socio',
      nome: process.env.SOCIO_NAME || 'Sócio Imperatriz',
      papel: 'socio',
      ativo: true,
      criadoEm: new Date().toISOString(),
      ...c
    });
  }
  await writeUsers(arr);
}

/** Garante o admin ALEX / ALEX123 (cria ou atualiza senha, papel e status). */
async function ensureAlexAdmin(hashSenha) {
  const arr = await readUsers();
  const senha = process.env.ALEX_PASSWORD || 'ALEX123';
  const cred = hashSenha(senha);
  const existente = arr.find(u => String(u.usuario || '').toLowerCase() === 'alex');
  if (existente) {
    existente.nome = process.env.ALEX_NAME || 'ALEX';
    existente.papel = 'admin';
    existente.ativo = true;
    Object.assign(existente, cred);
  } else {
    arr.push({
      id: crypto.randomUUID(),
      usuario: 'alex',
      nome: process.env.ALEX_NAME || 'ALEX',
      papel: 'admin',
      ativo: true,
      criadoEm: new Date().toISOString(),
      ...cred
    });
  }
  await writeUsers(arr);
}

function mapVerif(v, arquivos) {
  return {
    id: v.id,
    criadoEm: v.criado_em,
    nome: v.nome,
    telefone: v.telefone,
    endereco: v.endereco,
    cpf: v.cpf,
    rg: v.rg,
    status: v.status,
    observacao: v.observacao || '',
    clienteId: v.cliente_id || null,
    arquivos: (arquivos || []).filter(a => a.verificacao_id === v.id).map(a => ({
      id: a.id,
      campo: a.campo,
      nome: a.nome,
      mime: a.mime,
      arquivo: a.storage_path
    }))
  };
}

async function readVerifs() {
  const [verifs, arquivos] = await Promise.all([
    rest('GET', '/rest/v1/gestaoemprestimosalex_verificacoes?select=*&order=criado_em.desc'),
    rest('GET', '/rest/v1/gestaoemprestimosalex_verificacao_arquivos?select=*')
  ]);
  return (verifs || []).map(v => mapVerif(v, arquivos || []));
}

async function insertVerif(item, files) {
  await rest('POST', '/rest/v1/gestaoemprestimosalex_verificacoes', {
    id: item.id,
    criado_em: item.criadoEm,
    nome: item.nome,
    telefone: item.telefone,
    endereco: item.endereco,
    cpf: item.cpf,
    rg: item.rg,
    status: item.status || 'pendente',
    observacao: item.observacao || '',
    cliente_id: item.clienteId || null
  }, { Prefer: 'return=minimal' });

  const rows = [];
  for (const f of files) {
    const storagePath = item.id + '/' + f.arquivo;
    const up = await fetch(supabaseUrl() + '/storage/v1/object/' + BUCKET + '/' + storagePath, {
      method: 'POST',
      headers: headers({
        'Content-Type': f.mime || 'application/octet-stream',
        'x-upsert': 'true'
      }),
      body: f.data
    });
    if (!up.ok) {
      const t = await up.text();
      throw new Error(t || 'Falha ao enviar arquivo');
    }
    rows.push({
      id: f.id,
      verificacao_id: item.id,
      campo: f.campo,
      nome: f.nome,
      mime: f.mime,
      storage_path: storagePath
    });
  }
  if (rows.length) {
    await rest('POST', '/rest/v1/gestaoemprestimosalex_verificacao_arquivos', rows, { Prefer: 'return=minimal' });
  }
  item.arquivos = rows.map(a => ({ id: a.id, campo: a.campo, nome: a.nome, mime: a.mime, arquivo: a.storage_path }));
  return item;
}

async function deleteVerifDocumentos(item) {
  const paths = (item.arquivos || []).map(a => a.arquivo).filter(Boolean);
  if (paths.length) {
    await fetch(supabaseUrl() + '/storage/v1/object/' + BUCKET, {
      method: 'DELETE',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefixes: paths })
    });
  }
  await rest('DELETE', '/rest/v1/gestaoemprestimosalex_verificacao_arquivos?verificacao_id=eq.' + encodeURIComponent(item.id));
  item.arquivos = [];
  return item;
}

async function updateVerif(item) {
  if (item.status === 'rejeitado') await deleteVerifDocumentos(item);
  await rest('PATCH', '/rest/v1/gestaoemprestimosalex_verificacoes?id=eq.' + encodeURIComponent(item.id), {
    status: item.status,
    observacao: item.observacao || '',
    cliente_id: item.clienteId || null
  }, { Prefer: 'return=minimal' });
  return item;
}

async function deleteVerif(item) {
  await deleteVerifDocumentos(item);
  await rest('DELETE', '/rest/v1/gestaoemprestimosalex_verificacoes?id=eq.' + encodeURIComponent(item.id));
}

async function downloadArquivo(storagePath) {
  const r = await fetch(supabaseUrl() + '/storage/v1/object/' + BUCKET + '/' + storagePath, {
    headers: headers()
  });
  if (!r.ok) throw new Error('Arquivo não encontrado.');
  return Buffer.from(await r.arrayBuffer());
}

async function pingSchema() {
  if (!supabaseUrl() || !supabaseKey()) {
    throw new Error('Faltam SUPABASE_URL e SUPABASE_ANON_KEY nas variáveis de ambiente da Vercel (Settings → Environment Variables).');
  }
  try {
    await rest('GET', '/rest/v1/gestaoemprestimosalex_users?select=id,cidades_ids&limit=1');
  } catch (e) {
    if (/cidades_ids|42703/i.test(String(e.message || ''))) {
      throw new Error(
        'Coluna cidades_ids ausente no Supabase. No painel Supabase → SQL Editor, execute:\n' +
        'ALTER TABLE public.gestaoemprestimosalex_users ADD COLUMN IF NOT EXISTS cidades_ids JSONB DEFAULT NULL;\n' +
        "NOTIFY pgrst, 'reload schema';\n" +
        'Aguarde alguns segundos e recarregue a página do app.'
      );
    }
    throw e;
  }
}

async function readRevision() {
  const rows = await rest('GET', '/rest/v1/gestaoemprestimosalex_app_meta?select=revision&id=eq.1');
  if (Array.isArray(rows) && rows[0] && rows[0].revision != null) return Number(rows[0].revision);
  const atual = await readDb();
  return Number(atual.revision || 0);
}

function envStatus() {
  return {
    temUrl: Boolean(supabaseUrl()),
    temKey: Boolean(supabaseKey()),
    urlHost: (() => { try { return new URL(supabaseUrl()).host; } catch { return ''; } })()
  };
}

async function createSession(token, user, expiraMs) {
  await rest('POST', '/rest/v1/gestaoemprestimosalex_sessions', {
    token,
    user_json: user,
    expira: new Date(expiraMs).toISOString()
  }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
}

async function readSession(token) {
  const rows = await rest('GET', '/rest/v1/gestaoemprestimosalex_sessions?token=eq.' + encodeURIComponent(token) + '&select=*');
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  const expira = new Date(row.expira).getTime();
  if (expira < Date.now()) {
    await deleteSession(token);
    return null;
  }
  return { token, user: row.user_json, expira };
}

async function touchSession(token, expiraMs) {
  await rest('PATCH', '/rest/v1/gestaoemprestimosalex_sessions?token=eq.' + encodeURIComponent(token), {
    expira: new Date(expiraMs).toISOString()
  }, { Prefer: 'return=minimal' });
}

async function deleteSession(token) {
  await rest('DELETE', '/rest/v1/gestaoemprestimosalex_sessions?token=eq.' + encodeURIComponent(token));
}

module.exports = {
  readDb,
  writeDb,
  readUsers,
  writeUsers,
  updateUser,
  initUsers,
  ensureAlexAdmin,
  readVerifs,
  insertVerif,
  updateVerif,
  deleteVerif,
  downloadArquivo,
  pingSchema,
  envStatus,
  readRevision,
  createSession,
  readSession,
  touchSession,
  deleteSession
};
