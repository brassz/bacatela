'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'automacao.json');

function hojeISO() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function padrao() {
  return {
    ativo: false,
    pastas: ['ativo'],
    dataInicio: hojeISO(),
    dataFim: hojeISO(),
    soVencidos: true,
    intervaloMinutos: 180,
    ultimaExecucao: null,
    log: []
  };
}

function ler() {
  try {
    if (!fs.existsSync(FILE)) return padrao();
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Object.assign(padrao(), j, { log: Array.isArray(j.log) ? j.log.slice(-200) : [] });
  } catch {
    return padrao();
  }
}

function salvar(cfg) {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  const atual = Object.assign(padrao(), cfg);
  atual.log = Array.isArray(atual.log) ? atual.log.slice(-200) : [];
  fs.writeFileSync(FILE, JSON.stringify(atual, null, 2));
  return atual;
}

function registrarEnvio(item) {
  const cfg = ler();
  cfg.log.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    em: new Date().toISOString(),
    data: hojeISO(),
    ok: item.ok !== false,
    cliente: item.cliente || '',
    telefone: item.telefone || '',
    empId: item.empId || '',
    erro: item.erro || ''
  });
  cfg.log = cfg.log.slice(0, 200);
  return salvar(cfg);
}

function enviadoHoje(empId) {
  const d = hojeISO();
  return (ler().log || []).some(x => x.ok && x.data === d && String(x.empId) === String(empId));
}

function ehRenovacao(p) {
  return p && (
    p.tipo === 'renovacao_taxa' ||
    p.tipo === 'renovacao_juros' ||
    p.tipo === 'multa' ||
    p.tipo === 'emp_meta' ||
    p.forma === '_META_'
  );
}

function pagoParc(pags, eid, pid) {
  return (pags || []).filter(p =>
    String(p.empId) === String(eid) &&
    String(p.parcId) === String(pid) &&
    !ehRenovacao(p)
  ).reduce((a, p) => a + Number(p.valor || 0), 0);
}

function restanteParcela(e, p, pags) {
  return Math.max(0, Number(p.valor || 0) - pagoParc(pags, e.id, p.id));
}

function pastaEmp(e) {
  return (e && (e.pasta === 'negociado' || e.pasta === 'complicado')) ? e.pasta : 'ativo';
}

function jurosEmp(e) {
  return Math.max(0, +(Number(e.total || 0) - Number(e.principal || 0)).toFixed(2));
}

function ehFranca(c, cidades) {
  if (!c) return false;
  const z = (cidades || []).find(x => String(x.nome || '').toLowerCase().includes('franca'));
  if (z && String(c.cidadeId || '') === String(z.id)) return true;
  return /franca/i.test(String(c.unidade || c.cidade || ''));
}

function brl(n) {
  return Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function dataBR(s) {
  if (!s) return '';
  const [a, m, d] = String(s).split('-');
  return `${d}/${m}/${a}`;
}

const DADOS = { banco: 'Nubank', titular: 'Alg comercial ou Al gavioli lanches', pixExibir: '(16) 99175-3893' };

function montarTexto(c, e, parcela, restante, franca) {
  if (franca) {
    return `Olá, ${c.nome}. Tudo bem?\n\nConsta em nosso controle uma cobrança vencida em ${dataBR(parcela.data)}.\n\nPagamento Parcela ${parcela.n}\nValor da parcela: ${brl(restante)}\n\nDados para pagamento:\nPix - CNPJ 60.495.244/0001-14\nAf Capel Serviços de Cobrança Ltda.`;
  }
  const juros = jurosEmp(e);
  const quitacao = +(Number(e.principal || 0) + juros).toFixed(2);
  return `Olá, ${c.nome}. Tudo bem?\n\nConsta em nosso controle uma cobrança vencida em ${dataBR(parcela.data)}.\n\nQuitação total (emprestado + juros): ${brl(quitacao)}\nValor dos juros: ${brl(juros)}\nPagamento mínimo (parcela): ${brl(restante)}\n\nDados para pagamento:\n💳 PIX – ${DADOS.banco}\nTitular: ${DADOS.titular}\nChave: ${DADOS.pixExibir}\n\nApós o pagamento, por favor envie o comprovante. Obrigado.`;
}

function candidatos(db, filtro) {
  const pastas = new Set((filtro.pastas && filtro.pastas.length ? filtro.pastas : ['ativo', 'negociado', 'complicado']).map(String));
  const ini = String(filtro.dataInicio || '0000-01-01');
  const fim = String(filtro.dataFim || '9999-12-31');
  const soVencidos = filtro.soVencidos !== false;
  const hoje = hojeISO();
  const clientes = new Map((db.clientes || []).map(c => [String(c.id), c]));
  const pags = db.pagamentos || [];
  const out = [];
  for (const e of db.emprestimos || []) {
    if (!pastas.has(pastaEmp(e))) continue;
    const c = clientes.get(String(e.clienteId));
    if (!c) continue;
    const parc = (e.parcelas || [])
      .filter(p => {
        const rest = restanteParcela(e, p, pags);
        if (rest <= 0.01) return false;
        const d = String(p.data || '');
        if (d < ini || d > fim) return false;
        if (soVencidos && d > hoje) return false;
        return true;
      })
      .sort((a, b) => String(a.data).localeCompare(String(b.data)));
    if (!parc.length) continue;
    const primeira = parc[0];
    const rest = restanteParcela(e, primeira, pags);
    out.push({
      empId: e.id,
      clienteId: c.id,
      cliente: c.nome,
      telefone: c.tel || '',
      pasta: pastaEmp(e),
      vencimento: primeira.data,
      parcela: primeira.n,
      valor: rest,
      texto: montarTexto(c, e, primeira, rest, ehFranca(c, db.cidades))
    });
  }
  out.sort((a, b) => String(a.vencimento).localeCompare(String(b.vencimento)) || String(a.cliente).localeCompare(String(b.cliente), 'pt-BR'));
  return out;
}

module.exports = {
  ler,
  salvar,
  registrarEnvio,
  enviadoHoje,
  candidatos,
  hojeISO
};
