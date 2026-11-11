/**
 * Carteira de Clientes da Oficina
 * Cloudflare Worker + D1
 *
 * Regra de cobrança: todo serviço feito no mês M (competência AAAA-MM)
 * entra na fatura do cliente daquele mês, que vence entre o dia_inicio
 * e o dia_fim do mês M+1 (padrão: dia 5 a 10).
 */

const COOKIE = 'carteira_sess';
const SESSAO_DIAS = 30;
const PBKDF2_ITER = 100000;
const MAX_TENTATIVAS = 8;
const JANELA_TENTATIVAS_MS = 15 * 60 * 1000;
const FUSO = 'America/Cuiaba';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    try {
      return await rotear(request, env, url);
    } catch (e) {
      if (e instanceof ErroHttp) return json({ erro: e.message }, e.status);
      console.error(e);
      return json({ erro: 'Erro interno no servidor.' }, 500);
    }
  },
};

/* ---------------------------------------------------------------- utilidades */

class ErroHttp extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const falha = (status, msg) => { throw new ErroHttp(status, msg); };

function json(dados, status = 200, headers = {}) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

async function lerJson(request) {
  const ct = request.headers.get('content-type') || '';
  if (!ct.includes('application/json')) falha(415, 'Envie os dados em JSON.');
  try {
    return await request.json();
  } catch {
    falha(400, 'JSON inválido.');
  }
}

const pad = (n) => String(n).padStart(2, '0');
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const deB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function hojeLocal() {
  // AAAA-MM-DD no fuso da oficina
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function competenciaDe(data) {
  return data.slice(0, 7);
}

function proximoMes(comp) {
  let [a, m] = comp.split('-').map(Number);
  m += 1;
  if (m > 12) { m = 1; a += 1; }
  return `${a}-${pad(m)}`;
}

function mesAnterior(comp) {
  let [a, m] = comp.split('-').map(Number);
  m -= 1;
  if (m < 1) { m = 12; a -= 1; }
  return `${a}-${pad(m)}`;
}

function ultimoDiaDoMes(comp) {
  const [a, m] = comp.split('-').map(Number);
  return new Date(Date.UTC(a, m, 0)).getUTCDate();
}

function janelaVencimento(comp, cfg) {
  const prox = proximoMes(comp);
  const ultimo = ultimoDiaDoMes(prox);
  const ini = Math.min(cfg.dia_inicio, ultimo);
  const fim = Math.min(cfg.dia_fim, ultimo);
  return { inicio: `${prox}-${pad(ini)}`, fim: `${prox}-${pad(fim)}` };
}

function statusFatura(f, hoje, cfg) {
  const saldo = f.total - f.pago;
  const compAtual = competenciaDe(hoje);
  const { inicio, fim } = janelaVencimento(f.competencia, cfg);
  if (f.total > 0 && saldo <= 0) return { status: 'paga', inicio, fim };
  if (f.competencia >= compAtual) return { status: 'em_aberto', inicio, fim };
  if (hoje < inicio) return { status: 'a_vencer', inicio, fim };
  if (hoje <= fim) return { status: 'no_prazo', inicio, fim };
  return { status: 'vencida', inicio, fim };
}

function validarData(s, campo = 'data') {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) falha(400, `Informe a ${campo} no formato AAAA-MM-DD.`);
  const d = new Date(s + 'T12:00:00Z');
  if (isNaN(d) || d.toISOString().slice(0, 10) !== s) falha(400, `A ${campo} informada não existe.`);
  return s;
}

function validarComp(s) {
  if (typeof s !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) falha(400, 'Competência inválida (use AAAA-MM).');
  return s;
}

function validarCentavos(v, campo = 'valor') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 100000000000) falha(400, `Informe um ${campo} válido maior que zero.`);
  return n;
}

function texto(v, max = 500) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

async function lerConfig(env) {
  const { results } = await env.DB.prepare('SELECT chave, valor FROM config').all();
  const c = Object.fromEntries(results.map((r) => [r.chave, r.valor]));
  return {
    dia_inicio: Number(c.dia_inicio || 5),
    dia_fim: Number(c.dia_fim || 10),
    nome_oficina: c.nome_oficina || 'Minha Oficina',
    chave_pix: c.chave_pix || '',
  };
}

/* ------------------------------------------------------------ autenticação */

async function hashSenha(senha) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derivar(senha, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(bits)}`;
}

async function derivar(senha, salt, iter) {
  const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, chave, 256);
}

async function conferirSenha(senha, armazenado) {
  const [alg, iter, salt, hash] = String(armazenado).split('$');
  if (alg !== 'pbkdf2') return false;
  const bits = new Uint8Array(await derivar(senha, deB64(salt), Number(iter)));
  const esperado = deB64(hash);
  if (bits.length !== esperado.length) return false;
  let dif = 0;
  for (let i = 0; i < bits.length; i++) dif |= bits[i] ^ esperado[i];
  return dif === 0;
}

async function sha256Hex(s) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

function lerCookie(request, nome) {
  const c = request.headers.get('cookie') || '';
  for (const parte of c.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nome) return v.join('=');
  }
  return null;
}

function cookieSessao(url, token, maxAge) {
  const seguro = url.protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${seguro}`;
}

async function criarSessao(env, url, usuarioId) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const expira = Date.now() + SESSAO_DIAS * 86400 * 1000;
  await env.DB.prepare('INSERT INTO sessoes (token_hash, usuario_id, expira_em) VALUES (?, ?, ?)')
    .bind(await sha256Hex(token), usuarioId, expira).run();
  // limpeza oportunista de sessões vencidas
  await env.DB.prepare('DELETE FROM sessoes WHERE expira_em < ?').bind(Date.now()).run();
  return cookieSessao(url, token, SESSAO_DIAS * 86400);
}

async function usuarioDaSessao(request, env) {
  const token = lerCookie(request, COOKIE);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const u = await env.DB.prepare(
    `SELECT u.id, u.nome, u.usuario, u.admin FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
     WHERE s.token_hash = ? AND s.expira_em > ? AND u.ativo = 1`
  ).bind(await sha256Hex(token), Date.now()).first();
  return u ? { ...u, admin: !!u.admin } : null;
}

/* ------------------------------------------------------------------ rotas */

async function rotear(request, env, url) {
  const metodo = request.method;
  const caminho = url.pathname.replace(/\/+$/, '');
  const partes = caminho.split('/').slice(2); // remove '', 'api'

  // proteção contra requisições de outros sites
  if (metodo !== 'GET' && metodo !== 'HEAD') {
    const origem = request.headers.get('origin');
    if (origem && new URL(origem).host !== url.host) falha(403, 'Origem não permitida.');
  }

  // rotas públicas
  if (caminho === '/api/setup' && metodo === 'GET') return precisaSetup(env);
  if (caminho === '/api/setup' && metodo === 'POST') return fazerSetup(request, env, url);
  if (caminho === '/api/login' && metodo === 'POST') return login(request, env, url);
  if (caminho === '/api/logout' && metodo === 'POST') return logout(request, env, url);

  const eu = await usuarioDaSessao(request, env);
  if (!eu) falha(401, 'Faça login para continuar.');
  const soAdmin = () => { if (!eu.admin) falha(403, 'Apenas administradores podem fazer isso.'); };

  const [rec, id, sub] = partes;

  switch (rec) {
    case 'me':
      if (metodo === 'GET' && !id) return json({ usuario: eu, config: await lerConfig(env), hoje: hojeLocal() });
      if (metodo === 'PUT' && id === 'senha') return trocarMinhaSenha(request, env, eu);
      break;

    case 'config':
      if (metodo === 'GET') return json(await lerConfig(env));
      if (metodo === 'PUT') { soAdmin(); return salvarConfig(request, env); }
      break;

    case 'painel':
      if (metodo === 'GET') return painel(env);
      break;

    case 'clientes':
      if (metodo === 'GET' && !id) return listarClientes(env, url);
      if (metodo === 'POST' && !id) return criarCliente(request, env);
      if (metodo === 'GET' && id) return detalheCliente(env, Number(id));
      if (metodo === 'PUT' && id) return editarCliente(request, env, Number(id));
      if (metodo === 'DELETE' && id) return excluirCliente(env, Number(id));
      break;

    case 'servicos':
      if (metodo === 'GET' && !id) return listarServicos(env, url);
      if (metodo === 'POST' && !id) return criarServico(request, env, eu);
      if (metodo === 'PUT' && id) return editarServico(request, env, Number(id));
      if (metodo === 'DELETE' && id) return excluirServico(env, Number(id));
      break;

    case 'faturas':
      if (metodo === 'GET' && !id) return listarFaturas(env, url);
      if (metodo === 'GET' && id && sub) return detalheFatura(env, Number(id), validarComp(sub));
      break;

    case 'pagamentos':
      if (metodo === 'POST' && !id) return criarPagamento(request, env, eu);
      if (metodo === 'DELETE' && id) return excluirPagamento(env, Number(id));
      break;

    case 'usuarios':
      soAdmin();
      if (metodo === 'GET' && !id) return listarUsuarios(env);
      if (metodo === 'POST' && !id) return criarUsuario(request, env);
      if (metodo === 'PUT' && id) return editarUsuario(request, env, Number(id), eu);
      break;
  }
  falha(404, 'Rota não encontrada.');
}

/* --------------------------------------------------------- setup e login */

async function contarUsuarios(env) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM usuarios').first();
  return r.n;
}

async function precisaSetup(env) {
  return json({ precisaSetup: (await contarUsuarios(env)) === 0 });
}

function validarNovaSenha(senha) {
  if (typeof senha !== 'string' || senha.length < 8) falha(400, 'A senha precisa ter pelo menos 8 caracteres.');
  if (senha.length > 200) falha(400, 'Senha longa demais.');
}

function validarUsuario(usuario) {
  const u = texto(usuario, 40);
  if (!u || !/^[a-zA-Z0-9._-]{3,40}$/.test(u)) falha(400, 'Usuário deve ter de 3 a 40 caracteres (letras, números, ponto, traço ou sublinhado).');
  return u.toLowerCase();
}

async function fazerSetup(request, env, url) {
  if ((await contarUsuarios(env)) > 0) falha(409, 'O sistema já foi configurado.');
  const b = await lerJson(request);
  const nome = texto(b.nome, 80) || falha(400, 'Informe seu nome.');
  const usuario = validarUsuario(b.usuario);
  validarNovaSenha(b.senha);
  const r = await env.DB.prepare('INSERT INTO usuarios (nome, usuario, senha_hash, admin) VALUES (?, ?, ?, 1)')
    .bind(nome, usuario, await hashSenha(b.senha)).run();
  if (b.nome_oficina) {
    await env.DB.prepare("UPDATE config SET valor = ? WHERE chave = 'nome_oficina'").bind(texto(b.nome_oficina, 80)).run();
  }
  const cookie = await criarSessao(env, url, r.meta.last_row_id);
  return json({ ok: true }, 201, { 'set-cookie': cookie });
}

async function login(request, env, url) {
  const b = await lerJson(request);
  const usuario = String(b.usuario || '').trim().toLowerCase();
  const senha = String(b.senha || '');
  if (!usuario || !senha) falha(400, 'Informe usuário e senha.');

  const desde = Date.now() - JANELA_TENTATIVAS_MS;
  const t = await env.DB.prepare('SELECT COUNT(*) AS n FROM tentativas_login WHERE usuario = ? AND quando > ?').bind(usuario, desde).first();
  if (t.n >= MAX_TENTATIVAS) falha(429, 'Muitas tentativas. Aguarde 15 minutos e tente de novo.');

  const u = await env.DB.prepare('SELECT id, senha_hash, ativo FROM usuarios WHERE usuario = ?').bind(usuario).first();
  const ok = u && u.ativo && (await conferirSenha(senha, u.senha_hash));
  if (!ok) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO tentativas_login (usuario, quando) VALUES (?, ?)').bind(usuario, Date.now()),
      env.DB.prepare('DELETE FROM tentativas_login WHERE quando < ?').bind(desde),
    ]);
    falha(401, 'Usuário ou senha incorretos.');
  }
  await env.DB.prepare('DELETE FROM tentativas_login WHERE usuario = ?').bind(usuario).run();
  const cookie = await criarSessao(env, url, u.id);
  return json({ ok: true }, 200, { 'set-cookie': cookie });
}

async function logout(request, env, url) {
  const token = lerCookie(request, COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessoes WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': cookieSessao(url, '', 0) });
}

async function trocarMinhaSenha(request, env, eu) {
  const b = await lerJson(request);
  const u = await env.DB.prepare('SELECT senha_hash FROM usuarios WHERE id = ?').bind(eu.id).first();
  if (!(await conferirSenha(String(b.senha_atual || ''), u.senha_hash))) falha(400, 'A senha atual está incorreta.');
  validarNovaSenha(b.senha_nova);
  await env.DB.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').bind(await hashSenha(b.senha_nova), eu.id).run();
  return json({ ok: true });
}

/* ------------------------------------------------------------------ config */

async function salvarConfig(request, env) {
  const b = await lerJson(request);
  const ini = Number(b.dia_inicio);
  const fim = Number(b.dia_fim);
  if (!Number.isInteger(ini) || !Number.isInteger(fim) || ini < 1 || fim > 31 || ini > fim) {
    falha(400, 'Os dias de vencimento precisam estar entre 1 e 31, com o início antes do fim.');
  }
  const stmt = env.DB.prepare('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor');
  await env.DB.batch([
    stmt.bind('dia_inicio', String(ini)),
    stmt.bind('dia_fim', String(fim)),
    stmt.bind('nome_oficina', texto(b.nome_oficina, 80) || 'Minha Oficina'),
    stmt.bind('chave_pix', texto(b.chave_pix, 120) || ''),
  ]);
  return json(await lerConfig(env));
}

/* ----------------------------------------------------------------- faturas */

const SQL_FATURAS = `
  WITH s AS (
    SELECT cliente_id, competencia, SUM(valor_centavos) AS total, COUNT(*) AS qtd
    FROM servicos GROUP BY cliente_id, competencia
  ),
  p AS (
    SELECT cliente_id, competencia, SUM(valor_centavos) AS pago
    FROM pagamentos GROUP BY cliente_id, competencia
  )
  SELECT s.cliente_id, s.competencia, s.total, s.qtd, COALESCE(p.pago, 0) AS pago,
         c.nome AS cliente_nome, c.telefone AS cliente_telefone
  FROM s
  JOIN clientes c ON c.id = s.cliente_id
  LEFT JOIN p ON p.cliente_id = s.cliente_id AND p.competencia = s.competencia
`;

async function buscarFaturas(env, filtros = {}) {
  const cond = [];
  const params = [];
  if (filtros.competencia) { cond.push('s.competencia = ?'); params.push(filtros.competencia); }
  if (filtros.cliente_id) { cond.push('s.cliente_id = ?'); params.push(filtros.cliente_id); }
  const sql = SQL_FATURAS + (cond.length ? ' WHERE ' + cond.join(' AND ') : '') + ' ORDER BY s.competencia DESC, c.nome COLLATE NOCASE';
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  const cfg = filtros.cfg || (await lerConfig(env));
  const hoje = hojeLocal();
  return results.map((f) => ({ ...f, saldo: f.total - f.pago, ...statusFatura(f, hoje, cfg) }));
}

async function listarFaturas(env, url) {
  const comp = url.searchParams.get('competencia');
  const status = url.searchParams.get('status');
  let faturas = await buscarFaturas(env, { competencia: comp ? validarComp(comp) : null });
  if (status === 'pendentes') faturas = faturas.filter((f) => f.saldo > 0 && f.status !== 'em_aberto');
  else if (status) faturas = faturas.filter((f) => f.status === status);
  const resumo = faturas.reduce((a, f) => {
    a.total += f.total; a.pago += f.pago; a.saldo += Math.max(f.saldo, 0); return a;
  }, { total: 0, pago: 0, saldo: 0, quantidade: faturas.length });
  return json({ faturas, resumo });
}

async function detalheFatura(env, clienteId, comp) {
  const cliente = await env.DB.prepare('SELECT * FROM clientes WHERE id = ?').bind(clienteId).first();
  if (!cliente) falha(404, 'Cliente não encontrado.');
  const [servicos, pagamentos, faturas] = await Promise.all([
    env.DB.prepare('SELECT * FROM servicos WHERE cliente_id = ? AND competencia = ? ORDER BY data_servico, id').bind(clienteId, comp).all(),
    env.DB.prepare('SELECT * FROM pagamentos WHERE cliente_id = ? AND competencia = ? ORDER BY data_pagamento, id').bind(clienteId, comp).all(),
    buscarFaturas(env, { cliente_id: clienteId, competencia: comp }),
  ]);
  const cfg = await lerConfig(env);
  const fatura = faturas[0] || { cliente_id: clienteId, competencia: comp, total: 0, pago: 0, saldo: 0, qtd: 0, ...statusFatura({ competencia: comp, total: 0, pago: 0 }, hojeLocal(), cfg) };
  return json({ cliente, fatura, servicos: servicos.results, pagamentos: pagamentos.results });
}

async function painel(env) {
  const cfg = await lerConfig(env);
  const hoje = hojeLocal();
  const compAtual = competenciaDe(hoje);
  const compCobranca = mesAnterior(compAtual);
  const faturas = await buscarFaturas(env, { cfg });

  const somar = (lista, campo) => lista.reduce((a, f) => a + Math.max(f[campo], 0), 0);
  const doMes = faturas.filter((f) => f.competencia === compAtual);
  const daCobranca = faturas.filter((f) => f.competencia === compCobranca);
  const vencidas = faturas.filter((f) => f.status === 'vencida').sort((a, b) => b.saldo - a.saldo);
  const pendentesCobranca = daCobranca.filter((f) => f.saldo > 0).sort((a, b) => b.saldo - a.saldo);

  const recebido = await env.DB.prepare(
    "SELECT COALESCE(SUM(valor_centavos), 0) AS v FROM pagamentos WHERE substr(data_pagamento, 1, 7) = ?"
  ).bind(compAtual).first();

  const ultimos = await env.DB.prepare(
    `SELECT s.*, c.nome AS cliente_nome FROM servicos s JOIN clientes c ON c.id = s.cliente_id
     ORDER BY s.id DESC LIMIT 8`
  ).all();

  return json({
    hoje,
    config: cfg,
    mes_atual: { competencia: compAtual, total: somar(doMes, 'total'), clientes: doMes.length, ...janelaVencimento(compAtual, cfg) },
    cobranca: {
      competencia: compCobranca,
      ...janelaVencimento(compCobranca, cfg),
      total: somar(daCobranca, 'total'),
      recebido: daCobranca.reduce((a, f) => a + Math.min(f.pago, f.total), 0),
      saldo: somar(daCobranca, 'saldo'),
      clientes_pendentes: pendentesCobranca.length,
      lista: pendentesCobranca.slice(0, 12),
    },
    vencidas: { total: somar(vencidas, 'saldo'), quantidade: vencidas.length, lista: vencidas.slice(0, 12) },
    recebido_no_mes: recebido.v,
    ultimos_servicos: ultimos.results,
  });
}

/* ---------------------------------------------------------------- clientes */

async function listarClientes(env, url) {
  const q = (url.searchParams.get('q') || '').trim();
  const inativos = url.searchParams.get('inativos') === '1';
  const cond = [];
  const params = [];
  if (!inativos) cond.push('c.ativo = 1');
  if (q) {
    cond.push('(c.nome LIKE ? OR c.telefone LIKE ? OR c.documento LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const sql = `
    SELECT c.*,
      COALESCE((SELECT SUM(valor_centavos) FROM servicos WHERE cliente_id = c.id), 0) AS total_servicos,
      COALESCE((SELECT SUM(valor_centavos) FROM pagamentos WHERE cliente_id = c.id), 0) AS total_pago,
      (SELECT MAX(data_servico) FROM servicos WHERE cliente_id = c.id) AS ultimo_servico
    FROM clientes c
    ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
    ORDER BY c.nome COLLATE NOCASE
    LIMIT 500`;
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return json({ clientes: results.map((c) => ({ ...c, saldo: c.total_servicos - c.total_pago })) });
}

function dadosCliente(b) {
  const nome = texto(b.nome, 120);
  if (!nome) falha(400, 'Informe o nome do cliente.');
  return {
    nome,
    telefone: texto(b.telefone, 30),
    documento: texto(b.documento, 30),
    observacoes: texto(b.observacoes, 1000),
  };
}

async function criarCliente(request, env) {
  const d = dadosCliente(await lerJson(request));
  const r = await env.DB.prepare('INSERT INTO clientes (nome, telefone, documento, observacoes) VALUES (?, ?, ?, ?)')
    .bind(d.nome, d.telefone, d.documento, d.observacoes).run();
  const cliente = await env.DB.prepare('SELECT * FROM clientes WHERE id = ?').bind(r.meta.last_row_id).first();
  return json({ cliente }, 201);
}

async function detalheCliente(env, id) {
  const cliente = await env.DB.prepare('SELECT * FROM clientes WHERE id = ?').bind(id).first();
  if (!cliente) falha(404, 'Cliente não encontrado.');
  const [faturas, servicos, pagamentos] = await Promise.all([
    buscarFaturas(env, { cliente_id: id }),
    env.DB.prepare('SELECT * FROM servicos WHERE cliente_id = ? ORDER BY data_servico DESC, id DESC').bind(id).all(),
    env.DB.prepare('SELECT * FROM pagamentos WHERE cliente_id = ? ORDER BY data_pagamento DESC, id DESC').bind(id).all(),
  ]);
  const porComp = (lista) => lista.reduce((a, x) => ((a[x.competencia] ||= []).push(x), a), {});
  const sv = porComp(servicos.results);
  const pg = porComp(pagamentos.results);
  return json({
    cliente,
    faturas: faturas.map((f) => ({ ...f, servicos: sv[f.competencia] || [], pagamentos: pg[f.competencia] || [] })),
    saldo_total: faturas.reduce((a, f) => a + Math.max(f.saldo, 0), 0),
  });
}

async function editarCliente(request, env, id) {
  const b = await lerJson(request);
  const d = dadosCliente(b);
  const ativo = b.ativo === false || b.ativo === 0 ? 0 : 1;
  const r = await env.DB.prepare('UPDATE clientes SET nome = ?, telefone = ?, documento = ?, observacoes = ?, ativo = ? WHERE id = ?')
    .bind(d.nome, d.telefone, d.documento, d.observacoes, ativo, id).run();
  if (!r.meta.changes) falha(404, 'Cliente não encontrado.');
  return json({ cliente: await env.DB.prepare('SELECT * FROM clientes WHERE id = ?').bind(id).first() });
}

async function excluirCliente(env, id) {
  const usos = await env.DB.prepare(
    'SELECT (SELECT COUNT(*) FROM servicos WHERE cliente_id = ?) + (SELECT COUNT(*) FROM pagamentos WHERE cliente_id = ?) AS n'
  ).bind(id, id).first();
  if (usos.n > 0) falha(409, 'Este cliente tem serviços ou pagamentos. Em vez de excluir, marque como inativo.');
  const r = await env.DB.prepare('DELETE FROM clientes WHERE id = ?').bind(id).run();
  if (!r.meta.changes) falha(404, 'Cliente não encontrado.');
  return json({ ok: true });
}

/* ---------------------------------------------------------------- serviços */

async function dadosServico(env, b) {
  const cliente_id = Number(b.cliente_id);
  if (!Number.isInteger(cliente_id) || cliente_id <= 0) falha(400, 'Escolha o cliente.');
  const existe = await env.DB.prepare('SELECT id FROM clientes WHERE id = ?').bind(cliente_id).first();
  if (!existe) falha(400, 'Cliente não encontrado.');
  const data_servico = validarData(b.data_servico, 'data do serviço');
  const descricao = texto(b.descricao, 1000);
  if (!descricao) falha(400, 'Descreva o serviço feito.');
  return {
    cliente_id,
    data_servico,
    competencia: competenciaDe(data_servico),
    veiculo: texto(b.veiculo, 80),
    descricao,
    valor_centavos: validarCentavos(b.valor_centavos),
  };
}

async function listarServicos(env, url) {
  const cond = [];
  const params = [];
  const comp = url.searchParams.get('competencia');
  const cli = url.searchParams.get('cliente_id');
  const q = (url.searchParams.get('q') || '').trim();
  if (comp) { cond.push('s.competencia = ?'); params.push(validarComp(comp)); }
  if (cli) { cond.push('s.cliente_id = ?'); params.push(Number(cli)); }
  if (q) {
    cond.push('(c.nome LIKE ? OR s.descricao LIKE ? OR s.veiculo LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const limite = Math.min(Number(url.searchParams.get('limite')) || 300, 1000);
  const { results } = await env.DB.prepare(
    `SELECT s.*, c.nome AS cliente_nome, u.nome AS criado_por_nome
     FROM servicos s JOIN clientes c ON c.id = s.cliente_id LEFT JOIN usuarios u ON u.id = s.criado_por
     ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
     ORDER BY s.data_servico DESC, s.id DESC LIMIT ?`
  ).bind(...params, limite).all();
  return json({ servicos: results, total: results.reduce((a, s) => a + s.valor_centavos, 0) });
}

async function criarServico(request, env, eu) {
  const d = await dadosServico(env, await lerJson(request));
  const r = await env.DB.prepare(
    'INSERT INTO servicos (cliente_id, data_servico, competencia, veiculo, descricao, valor_centavos, criado_por) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(d.cliente_id, d.data_servico, d.competencia, d.veiculo, d.descricao, d.valor_centavos, eu.id).run();
  const cfg = await lerConfig(env);
  return json({ servico: { id: r.meta.last_row_id, ...d }, vencimento: janelaVencimento(d.competencia, cfg) }, 201);
}

async function editarServico(request, env, id) {
  const d = await dadosServico(env, await lerJson(request));
  const r = await env.DB.prepare(
    'UPDATE servicos SET cliente_id = ?, data_servico = ?, competencia = ?, veiculo = ?, descricao = ?, valor_centavos = ? WHERE id = ?'
  ).bind(d.cliente_id, d.data_servico, d.competencia, d.veiculo, d.descricao, d.valor_centavos, id).run();
  if (!r.meta.changes) falha(404, 'Serviço não encontrado.');
  return json({ servico: { id, ...d } });
}

async function excluirServico(env, id) {
  const r = await env.DB.prepare('DELETE FROM servicos WHERE id = ?').bind(id).run();
  if (!r.meta.changes) falha(404, 'Serviço não encontrado.');
  return json({ ok: true });
}

/* -------------------------------------------------------------- pagamentos */

async function criarPagamento(request, env, eu) {
  const b = await lerJson(request);
  const cliente_id = Number(b.cliente_id);
  const competencia = validarComp(b.competencia);
  const existe = await env.DB.prepare('SELECT id FROM clientes WHERE id = ?').bind(cliente_id).first();
  if (!existe) falha(400, 'Cliente não encontrado.');
  const valor = validarCentavos(b.valor_centavos, 'valor pago');
  const data = validarData(b.data_pagamento || hojeLocal(), 'data do pagamento');
  const r = await env.DB.prepare(
    'INSERT INTO pagamentos (cliente_id, competencia, valor_centavos, data_pagamento, forma, observacao, criado_por) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(cliente_id, competencia, valor, data, texto(b.forma, 30), texto(b.observacao, 300), eu.id).run();
  return json({ pagamento: { id: r.meta.last_row_id } }, 201);
}

async function excluirPagamento(env, id) {
  const r = await env.DB.prepare('DELETE FROM pagamentos WHERE id = ?').bind(id).run();
  if (!r.meta.changes) falha(404, 'Pagamento não encontrado.');
  return json({ ok: true });
}

/* ---------------------------------------------------------------- usuários */

async function listarUsuarios(env) {
  const { results } = await env.DB.prepare('SELECT id, nome, usuario, admin, ativo, criado_em FROM usuarios ORDER BY nome COLLATE NOCASE').all();
  return json({ usuarios: results });
}

async function criarUsuario(request, env) {
  const b = await lerJson(request);
  const nome = texto(b.nome, 80) || falha(400, 'Informe o nome.');
  const usuario = validarUsuario(b.usuario);
  validarNovaSenha(b.senha);
  const ja = await env.DB.prepare('SELECT id FROM usuarios WHERE usuario = ?').bind(usuario).first();
  if (ja) falha(409, 'Já existe alguém com esse usuário.');
  await env.DB.prepare('INSERT INTO usuarios (nome, usuario, senha_hash, admin) VALUES (?, ?, ?, ?)')
    .bind(nome, usuario, await hashSenha(b.senha), b.admin ? 1 : 0).run();
  return listarUsuarios(env);
}

async function editarUsuario(request, env, id, eu) {
  const b = await lerJson(request);
  const alvo = await env.DB.prepare('SELECT * FROM usuarios WHERE id = ?').bind(id).first();
  if (!alvo) falha(404, 'Usuário não encontrado.');
  const nome = texto(b.nome, 80) || alvo.nome;
  const admin = b.admin === undefined ? alvo.admin : (b.admin ? 1 : 0);
  const ativo = b.ativo === undefined ? alvo.ativo : (b.ativo ? 1 : 0);
  if (id === eu.id && (!admin || !ativo)) falha(400, 'Você não pode tirar seu próprio acesso de administrador nem se desativar.');
  const stmts = [env.DB.prepare('UPDATE usuarios SET nome = ?, admin = ?, ativo = ? WHERE id = ?').bind(nome, admin, ativo, id)];
  if (b.senha) {
    validarNovaSenha(b.senha);
    stmts.push(env.DB.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').bind(await hashSenha(b.senha), id));
    if (id !== eu.id) stmts.push(env.DB.prepare('DELETE FROM sessoes WHERE usuario_id = ?').bind(id));
  }
  if (!ativo) stmts.push(env.DB.prepare('DELETE FROM sessoes WHERE usuario_id = ?').bind(id));
  await env.DB.batch(stmts);
  return listarUsuarios(env);
}
