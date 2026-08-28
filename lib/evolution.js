'use strict';

const fs = require('fs');
const path = require('path');

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

function baseUrl() {
  return String(process.env.EVOLUTION_API_URL || '').trim().replace(/\/$/, '');
}
function globalKey() {
  return String(process.env.EVOLUTION_API_KEY || '').trim();
}
function instanceKey() {
  return String(process.env.EVOLUTION_INSTANCE_KEY || process.env.EVOLUTION_API_KEY || '').trim();
}
function instanceName() {
  return String(process.env.EVOLUTION_INSTANCE || 'alexcobrancas').trim() || 'alexcobrancas';
}

function configurado() {
  return Boolean(baseUrl() && (instanceKey() || globalKey()));
}

async function evo(method, urlPath, body, useGlobal) {
  const base = baseUrl();
  const key = useGlobal ? (globalKey() || instanceKey()) : (instanceKey() || globalKey());
  if (!base || !key) throw new Error('Evolution API não configurada. Defina EVOLUTION_API_URL e EVOLUTION_API_KEY no .env.');
  const r = await fetch(base + urlPath, {
    method,
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const msg = mensagemErroEvo(data, text || ('HTTP ' + r.status));
    const err = new Error(msg);
    err.status = r.status;
    err.body = data;
    throw err;
  }
  return data;
}

function mensagemErroEvo(data, fallback) {
  const raw = data && data.response && data.response.message !== undefined
    ? data.response.message
    : (data && (data.message || data.error));
  const txt = achatarMsgEvo(raw);
  if (txt && txt !== 'Bad Request') return txt;
  return String(fallback || 'Falha no envio pelo WhatsApp.');
}

function achatarMsgEvo(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map(achatarMsgEvo).filter(Boolean).join(' ');
  if (typeof raw === 'object') {
    if (raw.exists === false) return 'Este telefone não possui WhatsApp.';
    if (raw.message) return achatarMsgEvo(raw.message);
  }
  return '';
}

function estadoDe(data) {
  return String(data?.instance?.state || data?.state || data?.connectionStatus || data?.instance?.connectionStatus || '').toLowerCase();
}

function qrDe(data) {
  return data?.base64 || data?.qrcode?.base64 || data?.qrcode || '';
}

function asArray(x) {
  if (Array.isArray(x)) return x;
  if (x && Array.isArray(x.instance)) return x.instance;
  if (x) return [x];
  return [];
}

async function fetchInstancia() {
  const name = instanceName();
  const list = asArray(await evo('GET', '/instance/fetchInstances'));
  return list.find(i => String(i.name || i.instanceName || '') === name) || list[0] || null;
}

async function garantirInstancia() {
  const name = instanceName();
  try {
    const inst = await fetchInstancia();
    if (inst) return inst;
  } catch {}
  const payload = {
    instanceName: name,
    qrcode: true,
    integration: 'WHATSAPP-BAILEYS'
  };
  if (instanceKey() && instanceKey() !== globalKey()) payload.token = instanceKey();
  return evo('POST', '/instance/create', payload, true);
}

async function status() {
  if (!configurado()) {
    return { ok: false, configurado: false, conectado: false, estado: 'offline', instancia: instanceName(), perfil: '', numero: '' };
  }
  const name = instanceName();
  let estado = 'close';
  try {
    const st = await evo('GET', '/instance/connectionState/' + encodeURIComponent(name));
    estado = estadoDe(st) || 'close';
  } catch (e) {
    if (e.status === 404) {
      return { ok: true, configurado: true, conectado: false, estado: 'inexistente', instancia: name, perfil: '', numero: '' };
    }
    throw e;
  }
  let perfil = '';
  let numero = '';
  try {
    const inst = await fetchInstancia();
    if (inst) {
      perfil = inst.profileName || '';
      const jid = String(inst.ownerJid || inst.number || '');
      numero = jid.replace(/@s\.whatsapp\.net$/i, '');
      if (!estado || estado === 'close') estado = String(inst.connectionStatus || estado).toLowerCase();
    }
  } catch {}
  return {
    ok: true,
    configurado: true,
    conectado: estado === 'open',
    estado,
    instancia: name,
    perfil,
    numero
  };
}

async function qrcode() {
  await garantirInstancia();
  const name = instanceName();
  const data = await evo('GET', '/instance/connect/' + encodeURIComponent(name));
  const qr = qrDe(data);
  return {
    ok: true,
    estado: estadoDe(data) || 'connecting',
    qr: typeof qr === 'string' ? qr : '',
    pairingCode: data?.pairingCode || null,
    instancia: name
  };
}

async function desconectar() {
  const name = instanceName();
  try {
    await evo('DELETE', '/instance/logout/' + encodeURIComponent(name));
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  return { ok: true, estado: 'close', conectado: false, instancia: name };
}

function soDigitos(n) {
  return String(n || '').replace(/\D/g, '');
}

function numeroWhatsApp(tel) {
  let n = soDigitos(tel);
  if (n.startsWith('550') && n.length >= 13) n = '55' + n.slice(3);
  if (n.startsWith('0')) n = n.replace(/^0+/, '');
  if ((n.length === 10 || n.length === 11) && !n.startsWith('55')) n = '55' + n;
  return n;
}

function variantesNumero(tel) {
  const base = numeroWhatsApp(tel);
  const out = [];
  const add = v => { if (v && !out.includes(v)) out.push(v); };
  add(base);
  if (base.startsWith('55') && base.length === 12 && /[6-9]/.test(base[4])) add(base.slice(0, 4) + '9' + base.slice(4));
  if (base.startsWith('55') && base.length === 13 && base[4] === '9') add(base.slice(0, 4) + base.slice(5));
  return out;
}

function erroHttp(msg, status) {
  const err = new Error(msg);
  err.status = status;
  return err;
}

async function numeroNoWhatsApp(numero) {
  const name = instanceName();
  const variantes = variantesNumero(numero);
  if (!variantes.length || variantes[0].length < 12) {
    throw erroHttp('Telefone inválido para WhatsApp.', 400);
  }
  for (const n of variantes) {
    try {
      const r = await evo('POST', '/chat/whatsappNumbers/' + encodeURIComponent(name), { numbers: [n] });
      const row = Array.isArray(r) ? r[0] : r;
      if (row && row.exists) return soDigitos(row.number) || n;
    } catch {
      return n;
    }
  }
  throw erroHttp('Este telefone não possui WhatsApp: ' + variantes[0], 400);
}

async function enviarTexto(numero, texto) {
  const name = instanceName();
  const msg = String(texto || '').trim();
  if (!msg) throw erroHttp('Mensagem vazia.', 400);
  const st = await status();
  if (!st.conectado) throw erroHttp('WhatsApp desconectado. Leia o QR Code na aba Automações.', 400);
  const n = await numeroNoWhatsApp(numero);
  const r = await evo('POST', '/message/sendText/' + encodeURIComponent(name), {
    number: n,
    text: msg
  });
  return { ok: true, id: r?.key?.id || r?.messageId || null, numero: n };
}

module.exports = {
  configurado,
  instanceName,
  status,
  qrcode,
  desconectar,
  enviarTexto,
  numeroWhatsApp
};
