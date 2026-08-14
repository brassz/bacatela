'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('./lib/db');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME_OK = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']);
const CAMPOS_ARQ = new Set(['rg_frente', 'rg_verso', 'cpf_foto', 'comprovante_endereco', 'ctps_identificacao', 'ctps_historico']);
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE || 'gestaoemprestimosalex';
const IS_PROD = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
const SESSION_HOURS = 12;
const ON_VERCEL = Boolean(process.env.VERCEL);

function signSession(user, expira) {
  const payload = Buffer.from(JSON.stringify({ user, expira })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function parseSessionToken(token) {
  try {
    const i = String(token).lastIndexOf('.');
    if (i < 1) return null;
    const payload = token.slice(0, i);
    const sig = token.slice(i + 1);
    const expect = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || !data.user || Number(data.expira) < Date.now()) return null;
    return data;
  } catch { return null; }
}

function hashSenha(senha, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(senha), salt, 64).toString('hex');
  return { salt, hash };
}
function senhaConfere(senha, rec) {
  try {
    const hash = crypto.scryptSync(String(senha), rec.salt, 64);
    const salvo = Buffer.from(rec.hash, 'hex');
    return hash.length === salvo.length && crypto.timingSafeEqual(hash, salvo);
  } catch { return false; }
}

const loginAttempts = new Map();

function json(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

async function readBody(req, limit = 5 * 1024 * 1024) {
  if (req.body != null) {
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8') || '{}');
    if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
    if (typeof req.body === 'object') return req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function cookieMap(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function getSession(req) {
  const token = cookieMap(req).sessao;
  if (!token) return null;
  const s = parseSessionToken(token);
  if (!s) return null;
  return { token, user: s.user, expira: s.expira };
}

function safeUser(u) { return { id: u.id, usuario: u.usuario, nome: u.nome, papel: u.papel, ativo: u.ativo !== false }; }
function podeGerenciarAcessos(user) { return user && (user.papel === 'admin' || user.papel === 'socio'); }
function timingEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function indexOfBuf(buf, needle, from) {
  return buf.indexOf(needle, from);
}
function parseMultipart(req, limit = ON_VERCEL ? 4 * 1024 * 1024 : 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] || '');
    const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!bm) return reject(new Error('NO_BOUNDARY'));
    const delim = Buffer.from('--' + (bm[1] || bm[2]).trim());
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('BODY_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const fields = {};
        const files = [];
        let start = indexOfBuf(buf, delim, 0);
        if (start < 0) throw new Error('BAD_MULTIPART');
        start += delim.length;
        while (start < buf.length) {
          if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
          if (buf[start] === 0x0d) start++;
          if (buf[start] === 0x0a) start++;
          const headerEnd = indexOfBuf(buf, Buffer.from('\r\n\r\n'), start);
          if (headerEnd < 0) break;
          const header = buf.slice(start, headerEnd).toString('utf8');
          const next = indexOfBuf(buf, delim, headerEnd + 4);
          if (next < 0) break;
          const body = buf.slice(headerEnd + 4, next - 2);
          const nameM = header.match(/name="([^"]+)"/i);
          const fileM = header.match(/filename="([^"]*)"/i);
          const mimeM = header.match(/Content-Type:\s*([^\r\n]+)/i);
          if (nameM) {
            if (fileM && fileM[1]) {
              files.push({
                campo: nameM[1],
                nome: path.basename(fileM[1].replace(/\\/g, '/')),
                mime: (mimeM && mimeM[1].trim().toLowerCase()) || 'application/octet-stream',
                data: body
              });
            } else {
              fields[nameM[1]] = body.toString('utf8');
            }
          }
          start = next + delim.length;
        }
        resolve({ fields, files });
      } catch (e) { reject(e); }
    });
  });
}
function extDeMime(mime, nome) {
  const e = path.extname(nome || '').toLowerCase();
  if (e && ['.jpg', '.jpeg', '.png', '.webp', '.pdf', '.heic', '.heif'].includes(e)) return e;
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('pdf')) return '.pdf';
  if (mime.includes('heic') || mime.includes('heif')) return '.heic';
  return '.jpg';
}
function publicCadastro(item) {
  return {
    id: item.id,
    criadoEm: item.criadoEm,
    nome: item.nome,
    telefone: item.telefone,
    endereco: item.endereco,
    cpf: item.cpf,
    rg: item.rg,
    status: item.status,
    observacao: item.observacao || '',
    clienteId: item.clienteId || null,
    arquivos: (item.arquivos || []).map(a => ({ id: a.id, campo: a.campo, nome: a.nome, mime: a.mime }))
  };
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'"
  };
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/favicon.ico') {
    res.writeHead(204, securityHeaders());
    return res.end();
  }
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { erro: 'Acesso negado' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { erro: 'Não encontrado' });
    const ext = path.extname(file).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', ...securityHeaders() });
    fs.createReadStream(file).pipe(res);
  });
}

async function handleApi(req, res) {
  const route = (req.url || '').split('?')[0];
  const ip = req.socket.remoteAddress || 'ip';

  if (route === '/api/cadastro' && req.method === 'POST') {
    try {
      const { fields, files } = await parseMultipart(req);
      const nome = String(fields.nome || '').trim();
      const telefone = String(fields.telefone || '').trim();
      const endereco = String(fields.endereco || '').trim();
      const cpf = String(fields.cpf || '').trim();
      const rg = String(fields.rg || '').trim();
      if (nome.length < 2 || !telefone || !endereco || !cpf || !rg) {
        return json(res, 400, { erro: 'Preencha nome, WhatsApp, endereço, CPF e RG.' });
      }
      if (String(fields.consentimento || '') !== 'on' && String(fields.consentimento || '') !== 'true') {
        return json(res, 400, { erro: 'É necessário autorizar o uso dos dados.' });
      }
      const validos = files.filter(f => CAMPOS_ARQ.has(f.campo) && f.data.length > 0);
      if (!validos.some(f => f.campo === 'rg_frente') || !validos.some(f => f.campo === 'comprovante_endereco')) {
        return json(res, 400, { erro: 'Anexe RG (frente) e comprovante de endereço.' });
      }
      for (const f of validos) {
        if (f.data.length > 8 * 1024 * 1024) return json(res, 413, { erro: 'Um dos arquivos ultrapassa 8 MB.' });
        if (!MIME_OK.has(f.mime) && !/\.(jpe?g|png|webp|pdf|heic|heif)$/i.test(f.nome)) {
          return json(res, 400, { erro: 'Envie somente imagens ou PDF.' });
        }
      }
      const id = crypto.randomUUID();
      const arquivos = validos.map((f, i) => {
        const arqId = crypto.randomUUID();
        const ext = extDeMime(f.mime, f.nome);
        const stored = `${String(i).padStart(2, '0')}_${f.campo}${ext}`;
        return { id: arqId, campo: f.campo, nome: f.nome, mime: f.mime, arquivo: stored, data: f.data };
      });
      const item = {
        id, criadoEm: new Date().toISOString(), nome, telefone, endereco, cpf, rg,
        status: 'pendente', observacao: '', arquivos: []
      };
      await db.insertVerif(item, arquivos);
      return json(res, 201, { ok: true, id });
    } catch (e) {
      if (e.message === 'BODY_TOO_LARGE') return json(res, 413, { erro: 'Arquivos muito grandes.' });
      return json(res, 400, { erro: 'Não foi possível enviar o cadastro.' });
    }
  }

  if (route === '/api/login' && req.method === 'POST') {
    const a = loginAttempts.get(ip) || { n: 0, desde: Date.now() };
    if (Date.now() - a.desde > 15 * 60 * 1000) { a.n = 0; a.desde = Date.now(); }
    if (a.n >= 20) return json(res, 429, { erro: 'Muitas tentativas. Tente novamente mais tarde.' });
    try {
      const body = await readBody(req, 50 * 1024);
      const u = (await db.readUsers()).find(x => String(x.usuario || '').toLowerCase() === String(body.usuario || '').trim().toLowerCase() && x.ativo !== false);
      if (!u || !senhaConfere(String(body.senha || ''), u)) {
        a.n += 1; loginAttempts.set(ip, a);
        return json(res, 401, { erro: 'Usuário ou senha inválidos.' });
      }
      loginAttempts.delete(ip);
      const expira = Date.now() + SESSION_HOURS * 3600 * 1000;
      const token = signSession(safeUser(u), expira);
      const cookie = `sessao=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}${IS_PROD ? '; Secure' : ''}`;
      return json(res, 200, safeUser(u), { 'Set-Cookie': cookie });
    } catch (e) {
      console.error('login', e);
      return json(res, 400, { erro: 'Dados inválidos.' });
    }
  }

  const session = getSession(req);
  if (!session) return json(res, 401, { erro: 'Sessão encerrada.' });

  if (route === '/api/me' && req.method === 'GET') return json(res, 200, session.user);
  if (route === '/api/logout' && req.method === 'POST') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'sessao=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }
  if (route === '/api/usuarios' && req.method === 'GET') {
    if (!podeGerenciarAcessos(session.user)) return json(res, 403, { erro: 'Somente administrador e sócio podem gerenciar acessos.' });
    return json(res, 200, (await db.readUsers()).map(safeUser));
  }
  if (route === '/api/usuarios' && req.method === 'POST') {
    if (!podeGerenciarAcessos(session.user)) return json(res, 403, { erro: 'Somente administrador e sócio podem adicionar usuários.' });
    try {
      const body = await readBody(req, 50 * 1024);
      const usuario = String(body.usuario || '').trim().toLowerCase();
      const nome = String(body.nome || '').trim();
      const senha = String(body.senha || '');
      if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) return json(res, 400, { erro: 'Usuário deve ter 3 a 30 caracteres: letras, números, ponto, traço ou sublinhado.' });
      if (nome.length < 2) return json(res, 400, { erro: 'Informe o nome do usuário.' });
      if (senha.length < 8) return json(res, 400, { erro: 'A senha deve ter pelo menos 8 caracteres.' });
      const arr = await db.readUsers();
      if (arr.some(x => x.usuario.toLowerCase() === usuario)) return json(res, 409, { erro: 'Este usuário já existe.' });
      const cred = hashSenha(senha);
      const papel = body.papel === 'funcionario' ? 'funcionario' : 'socio';
      const novo = { id: crypto.randomUUID(), usuario, nome, papel, ativo: true, criadoEm: new Date().toISOString(), ...cred };
      arr.push(novo); await db.writeUsers(arr);
      return json(res, 201, safeUser(novo));
    } catch { return json(res, 400, { erro: 'Não foi possível criar o sócio.' }); }
  }
  if (route.startsWith('/api/usuarios/') && req.method === 'PUT') {
    if (!podeGerenciarAcessos(session.user)) return json(res, 403, { erro: 'Somente administrador e sócio podem alterar usuários.' });
    try {
      const id = decodeURIComponent(route.split('/').pop());
      const body = await readBody(req, 50 * 1024);
      const arr = await db.readUsers(); const u = arr.find(x => x.id === id);
      if (!u) return json(res, 404, { erro: 'Usuário não encontrado.' });
      if (u.papel === 'admin' && session.user.papel !== 'admin') return json(res, 403, { erro: 'O administrador principal não pode ser alterado.' });
      if (u.papel === 'admin' && body.ativo === false) return json(res, 400, { erro: 'O administrador principal não pode ser desativado.' });
      if (typeof body.nome === 'string' && body.nome.trim().length >= 2) u.nome = body.nome.trim();
      if (typeof body.ativo === 'boolean') u.ativo = body.ativo;
      if (typeof body.senha === 'string' && body.senha) {
        if (body.senha.length < 8) return json(res, 400, { erro: 'A nova senha deve ter pelo menos 8 caracteres.' });
        Object.assign(u, hashSenha(body.senha));
      }
      await db.writeUsers(arr); return json(res, 200, safeUser(u));
    } catch { return json(res, 400, { erro: 'Não foi possível alterar o usuário.' }); }
  }

  if (route === '/api/data' && req.method === 'GET') {
    const atual = await db.readDb();
    if (session.user.papel === 'funcionario') {
      return json(res, 200, { revision: atual.revision, data: { clientes: atual.data.clientes, emprestimos: atual.data.emprestimos || [], pagamentos: atual.data.pagamentos || [], cidades: atual.data.cidades || [] } });
    }
    return json(res, 200, atual);
  }
  if (route === '/api/data' && req.method === 'PUT') {
    try {
      const body = await readBody(req);
      const data = body.data;
      if (!data || !Array.isArray(data.clientes) || !Array.isArray(data.emprestimos) || !Array.isArray(data.pagamentos)) return json(res, 400, { erro: 'Banco inválido.' });
      const atual = await db.readDb();
      if (!Array.isArray(data.cidades)) data.cidades = atual.data.cidades || [];
      if (Number(body.revision) !== Number(atual.revision)) return json(res, 409, { erro: 'Outro usuário alterou os dados. Atualize a página antes de salvar.' });
      let dadosSalvar = data;
      if (session.user.papel === 'funcionario') {
        const idsAtuais = new Set(atual.data.clientes.map(c => c.id));
        const existentesBody = data.clientes.filter(c => idsAtuais.has(c.id));
        if (existentesBody.length !== atual.data.clientes.length) return json(res, 403, { erro: 'Funcionário não pode excluir clientes.' });
        const porId = new Map(data.clientes.map(c => [c.id, c]));
        for (const antigo of atual.data.clientes) {
          const recebido = porId.get(antigo.id);
          if (JSON.stringify(recebido) !== JSON.stringify(antigo)) return json(res, 403, { erro: 'Funcionário não pode alterar clientes já cadastrados.' });
        }
        const novos = data.clientes.filter(c => !idsAtuais.has(c.id)).map(c => ({ ...c, responsavel: session.user.nome || session.user.usuario, usuarioResponsavel: session.user.usuario, papelResponsavel: 'funcionario' }));
        const idsEmp = new Set((atual.data.emprestimos || []).map(e => e.id));
        const empBody = Array.isArray(data.emprestimos) ? data.emprestimos : [];
        if (empBody.filter(e => idsEmp.has(e.id)).length !== idsEmp.size) return json(res, 403, { erro: 'Funcionário não pode excluir empréstimos.' });
        const empPorId = new Map(empBody.map(e => [e.id, e]));
        const novosEmp = empBody.filter(e => !idsEmp.has(e.id));
        const idsClientes = new Set([...atual.data.clientes, ...novos].map(c => c.id));
        if (novosEmp.some(e => !idsClientes.has(e.clienteId))) return json(res, 400, { erro: 'Empréstimo sem cliente válido.' });
        const emprestimosFinais = (atual.data.emprestimos || []).map(antigo => empPorId.get(antigo.id) || antigo).concat(novosEmp);
        const idsPag = new Set((atual.data.pagamentos || []).map(p => p.id));
        const pagBody = Array.isArray(data.pagamentos) ? data.pagamentos : [];
        if (pagBody.filter(p => idsPag.has(p.id)).length !== idsPag.size) return json(res, 403, { erro: 'Funcionário não pode excluir pagamentos.' });
        const novosPag = pagBody.filter(p => !idsPag.has(p.id));
        dadosSalvar = { clientes: [...atual.data.clientes, ...novos], emprestimos: emprestimosFinais, pagamentos: [...(atual.data.pagamentos || []), ...novosPag], cidades: atual.data.cidades || [] };
      }
      const next = { revision: Number(atual.revision), data: dadosSalvar, atualizadoEm: new Date().toISOString(), atualizadoPor: session.user.usuario };
      const saved = await db.writeDb(next);
      return json(res, 200, { ok: true, revision: saved.revision });
    } catch (e) {
      if (e.message === 'revision_conflict') return json(res, 409, { erro: 'Outro usuário alterou os dados. Atualize a página antes de salvar.' });
      return json(res, e.message === 'BODY_TOO_LARGE' ? 413 : 400, { erro: 'Não foi possível salvar os dados.' });
    }
  }

  if (route === '/api/verificacoes' && req.method === 'GET') {
    if (session.user.papel === 'funcionario') return json(res, 403, { erro: 'Sem permissão.' });
    return json(res, 200, (await db.readVerifs()).map(publicCadastro));
  }
  const arqMatch = route.match(/^\/api\/verificacoes\/([^/]+)\/arquivo\/([^/]+)$/);
  if (arqMatch && req.method === 'GET') {
    if (session.user.papel === 'funcionario') return json(res, 403, { erro: 'Sem permissão.' });
    const item = (await db.readVerifs()).find(x => x.id === decodeURIComponent(arqMatch[1]));
    if (!item) return json(res, 404, { erro: 'Cadastro não encontrado.' });
    const arq = (item.arquivos || []).find(a => a.id === decodeURIComponent(arqMatch[2]));
    if (!arq) return json(res, 404, { erro: 'Arquivo não encontrado.' });
    try {
      const buf = await db.downloadArquivo(arq.arquivo);
      res.writeHead(200, { 'Content-Type': arq.mime || 'application/octet-stream', 'Content-Length': buf.length, 'Content-Disposition': 'inline; filename="' + encodeURIComponent(arq.nome) + '"', ...securityHeaders() });
      return res.end(buf);
    } catch {
      return json(res, 404, { erro: 'Arquivo não encontrado.' });
    }
  }
  const verMatch = route.match(/^\/api\/verificacoes\/([^/]+)$/);
  if (verMatch && req.method === 'DELETE') {
    if (session.user.papel === 'funcionario') return json(res, 403, { erro: 'Sem permissão.' });
    const item = (await db.readVerifs()).find(x => x.id === decodeURIComponent(verMatch[1]));
    if (!item) return json(res, 404, { erro: 'Cadastro não encontrado.' });
    try {
      await db.deleteVerif(item);
      return json(res, 200, { ok: true });
    } catch {
      return json(res, 400, { erro: 'Não foi possível excluir a verificação.' });
    }
  }
  if (verMatch && req.method === 'PUT') {
    if (session.user.papel === 'funcionario') return json(res, 403, { erro: 'Sem permissão.' });
    try {
      const body = await readBody(req, 50 * 1024);
      const arr = await db.readVerifs();
      const item = arr.find(x => x.id === decodeURIComponent(verMatch[1]));
      if (!item) return json(res, 404, { erro: 'Cadastro não encontrado.' });
      if (body.status === 'aprovado' || body.status === 'rejeitado' || body.status === 'pendente') item.status = body.status;
      if (typeof body.observacao === 'string') item.observacao = body.observacao.slice(0, 500);
      if (body.status === 'aprovado' && !item.clienteId) {
        const atual = await db.readDb();
        const agora = new Date();
        const pad = n => String(n).padStart(2, '0');
        const criadoEm = `${agora.getFullYear()}-${pad(agora.getMonth() + 1)}-${pad(agora.getDate())}`;
        const cliente = {
          id: crypto.randomUUID(),
          nome: item.nome,
          tel: item.telefone,
          doc: item.cpf,
          end: item.endereco,
          obs: 'Cadastro enviado pelo cliente (RG: ' + item.rg + ').',
          responsavel: session.user.nome || session.user.usuario,
          unidade: String(body.unidade || '').trim() || 'Sem cidade',
          cidadeId: String(body.cidadeId || '').trim() || null,
          criadoEm,
          criadoHora: `${pad(agora.getHours())}:${pad(agora.getMinutes())}:${pad(agora.getSeconds())}`
        };
        atual.data.clientes.push(cliente);
        atual.atualizadoPor = session.user.usuario;
        await db.writeDb(atual);
        item.clienteId = cliente.id;
      }
      await db.updateVerif(item);
      return json(res, 200, publicCadastro(item));
    } catch { return json(res, 400, { erro: 'Não foi possível atualizar a verificação.' }); }
  }

  return json(res, 404, { erro: 'Rota não encontrada.' });
}

function handleRequest(req, res) {
  Object.entries(securityHeaders()).forEach(([k, v]) => {
    try { res.setHeader(k, v); } catch {}
  });
  if ((req.url || '').startsWith('/api/')) {
    handleApi(req, res).catch(err => {
      console.error(err);
      if (!res.headersSent) json(res, 500, { erro: 'Erro interno.' });
    });
  } else {
    serveStatic(req, res);
  }
}

const server = http.createServer(handleRequest);

let readyPromise = null;
function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await db.pingSchema();
      await db.initUsers(hashSenha);
    })();
  }
  return readyPromise.catch(err => {
    readyPromise = null;
    throw err;
  });
}

ensureReady().then(() => {
  if (ON_VERCEL) return;
  server.listen(PORT, HOST, () => {
    console.log(`Empréstimos Imperatriz online em http://${HOST}:${PORT}`);
    console.log('Dados salvos no Supabase (tabelas gestaoemprestimosalex_*).');
    if (!IS_PROD) console.log('Teste local: admin/Admin123!. Cadastre sócios e funcionários na aba Acessos.');
  });
}).catch(e => {
  console.error('Supabase indisponível ou schema não aplicado.');
  console.error(e.message);
  if (!ON_VERCEL) process.exit(1);
});

async function vercelHandler(req, res) {
  const route = (req.url || '').split('?')[0];
  if (route === '/api/health' || route === '/health') {
    const st = db.envStatus();
    try {
      await db.pingSchema();
      return json(res, 200, { ok: true, ...st });
    } catch (e) {
      return json(res, 500, { ok: false, ...st, detalhe: e.message || String(e) });
    }
  }
  try {
    await ensureReady();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      const st = db.envStatus();
      json(res, 500, {
        erro: st.temUrl && st.temKey
          ? ('Falha ao conectar no Supabase: ' + (e.message || 'erro desconhecido'))
          : 'As variáveis existem no painel, mas este deploy não as está lendo. Marque Production e Preview, salve, e faça Redeploy (Redeploy with existing Build Cache desmarcado).',
        temUrl: st.temUrl,
        temKey: st.temKey,
        detalhe: e.message || String(e)
      });
    }
    return;
  }
  handleRequest(req, res);
}

module.exports = vercelHandler;
