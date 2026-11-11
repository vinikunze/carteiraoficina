-- Anotações de cobrança: o que foi conversado com o cliente e promessas de pagamento.
-- promessa_data no formato AAAA-MM-DD. promessa_centavos é opcional (valor prometido).

CREATE TABLE IF NOT EXISTS anotacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  texto TEXT NOT NULL DEFAULT '',
  promessa_data TEXT,
  promessa_centavos INTEGER,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_anotacoes_cliente ON anotacoes(cliente_id, id);
