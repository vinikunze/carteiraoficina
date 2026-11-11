-- Carteira de clientes da oficina
-- Valores em centavos (inteiro). Datas no formato AAAA-MM-DD. Competência no formato AAAA-MM.

CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  usuario TEXT NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash TEXT NOT NULL,
  admin INTEGER NOT NULL DEFAULT 0,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessoes (
  token_hash TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira_em INTEGER NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessoes_usuario ON sessoes(usuario_id);

CREATE TABLE IF NOT EXISTS tentativas_login (
  usuario TEXT NOT NULL,
  quando INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tentativas ON tentativas_login(usuario, quando);

CREATE TABLE IF NOT EXISTS config (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
INSERT OR IGNORE INTO config (chave, valor) VALUES
  ('dia_inicio', '5'),
  ('dia_fim', '10'),
  ('nome_oficina', 'Minha Oficina'),
  ('chave_pix', '');

CREATE TABLE IF NOT EXISTS clientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  telefone TEXT,
  documento TEXT,
  observacoes TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clientes_nome ON clientes(nome COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS servicos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  data_servico TEXT NOT NULL,
  competencia TEXT NOT NULL,
  veiculo TEXT,
  descricao TEXT NOT NULL,
  valor_centavos INTEGER NOT NULL,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_servicos_cliente_comp ON servicos(cliente_id, competencia);
CREATE INDEX IF NOT EXISTS idx_servicos_comp ON servicos(competencia);

CREATE TABLE IF NOT EXISTS pagamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  competencia TEXT NOT NULL,
  valor_centavos INTEGER NOT NULL,
  data_pagamento TEXT NOT NULL,
  forma TEXT,
  observacao TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pagamentos_cliente_comp ON pagamentos(cliente_id, competencia);
