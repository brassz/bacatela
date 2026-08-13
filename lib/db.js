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

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_ANON_KEY || '';
const BUCKET = 'gestaoemprestimosalex-documentos';

function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    ...extra
  };
}

async function rest(method, urlPath, body, extraHeaders = {}) {
  const r = await fetch(SUPABASE_URL + urlPath, {
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

async function readDb() {
  const x = await rpc('gestaoemprestimosalex_ler_estado');
  if (!x || !x.data) return { revision: 0, data: { clientes: [], emprestimos: [], pagamentos: [] } };
  x.data.clientes = x.data.clientes || [];
  x.data.emprestimos = x.data.emprestimos || [];
  x.data.pagamentos = x.data.pagamentos || [];
  return x;
}

async function writeDb(next) {
  try {
    return await rpc('gestaoemprestimosalex_salvar_estado', { p_payload: next });
  } catch (e) {
    if (String(e.message).includes('revision_conflict')) {
      const err = new Error('revision_conflict');
      throw err;
    }
    throw e;
  }
}

function mapUser(row) {
  return {
    id: row.id,
    usuario: row.username,
    nome: row.name,
    papel: row.role,
    ativo: row.active !== false,
    salt: row.salt,
    hash: row.password_hash,
    criadoEm: row.created_at
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
    created_at: u.criadoEm || new Date().toISOString()
  }));
  await rest('POST', '/rest/v1/gestaoemprestimosalex_users', rows, { Prefer: 'resolution=merge-duplicates,return=minimal' });
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
    const up = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + storagePath, {
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
    await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET, {
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
  const r = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + storagePath, {
    headers: headers()
  });
  if (!r.ok) throw new Error('Arquivo não encontrado.');
  return Buffer.from(await r.arrayBuffer());
}

async function pingSchema() {
  await rpc('gestaoemprestimosalex_ler_estado');
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
  initUsers,
  readVerifs,
  insertVerif,
  updateVerif,
  deleteVerif,
  downloadArquivo,
  pingSchema,
  createSession,
  readSession,
  touchSession,
  deleteSession
};
