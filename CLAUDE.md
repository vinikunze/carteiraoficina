# Carteira de Clientes da Oficina

Sistema web para uma oficina mecânica controlar o que cada cliente deve. A equipe lança os serviços feitos no dia a dia e o sistema agrupa tudo numa fatura mensal por cliente.

## Regra de negócio principal

- Todo serviço feito do dia 1 ao último dia do mês M (competência `AAAA-MM`) entra na fatura do cliente daquele mês.
- Essa fatura vence entre o `dia_inicio` e o `dia_fim` do mês M+1 (padrão: dia 5 a 10). Os dias ficam na tabela `config` e podem ser alterados em Ajustes.
- Exemplo: serviços de 01/11 a 30/11 são pagos entre 05/12 e 10/12.
- A competência é calculada a partir da data do serviço (`data_servico.slice(0, 7)`), nunca digitada.
- Pagamentos são registrados por cliente + competência e podem ser parciais.
- Situações da fatura (calculadas em `statusFatura` no backend, não ficam salvas):
  - `em_aberto`: mês corrente, ainda acumulando serviços
  - `a_vencer`: mês fechado, antes do dia de início
  - `no_prazo`: dentro da janela de pagamento (mostrado como "Vence agora")
  - `vencida`: passou do dia final e ainda tem saldo
  - `paga`: saldo zerado
- "Hoje" é sempre calculado no fuso `America/Cuiaba`.

## Stack

- Cloudflare Worker (`src/index.js`) servindo a API em `/api/*`
- Banco Cloudflare D1, binding `DB`, banco `carteira-oficina` (o ID já está no `wrangler.toml`)
- Frontend em um único arquivo `public/index.html` (HTML, CSS e JS puros, sem framework e sem build), servido como static assets pelo binding `ASSETS`
- Rotas do frontend por hash: `#/painel`, `#/lancar`, `#/servicos`, `#/cobrancas`, `#/fatura/:clienteId/:competencia`, `#/clientes`, `#/clientes/:id`, `#/config`
- Sem dependências em runtime. Só o `wrangler` como devDependency.

## Estrutura

```
src/index.js                  API: auth, clientes, serviços, faturas, pagamentos, usuários, config
public/index.html             Todas as telas
migrations/0001_inicial.sql   Schema do banco
wrangler.toml                 Config do Worker e do D1
LEIA-ME.md                    Guia para o usuário final
```

## Banco (D1)

Tabelas: `usuarios`, `sessoes`, `tentativas_login`, `config`, `clientes`, `servicos`, `pagamentos`.

- Valores em dinheiro sempre em **centavos inteiros** (`valor_centavos`). Nunca usar float para dinheiro.
- Datas em texto `AAAA-MM-DD`, competência em `AAAA-MM`.
- Faturas não têm tabela própria: são montadas pela query `SQL_FATURAS` (agrupa `servicos` e `pagamentos` por cliente e competência).
- Cliente com serviço ou pagamento não pode ser excluído, só marcado como inativo.
- Mudança de schema: criar um novo arquivo em `migrations/` (`0002_...sql`) e aplicar com `npm run migrar`. Nunca editar a migration 0001, que já foi aplicada em produção.

## Autenticação

- Usuário e senha, senha com hash PBKDF2 SHA-256 (100.000 iterações, limite do Workers).
- Sessão: token aleatório em cookie `carteira_sess` (HttpOnly, Secure, SameSite=Lax), salvo no banco como hash SHA-256, validade de 30 dias.
- Primeiro acesso (sem usuários no banco) mostra a tela de setup que cria o administrador.
- Papéis: `admin` (Ajustes e equipe) e equipe comum (lança serviços e recebe pagamentos).
- Bloqueio de 15 min após 8 tentativas erradas de login.
- Requisições que alteram dados com header `Origin` de outro domínio são recusadas.
- Rotas públicas: `GET/POST /api/setup`, `POST /api/login`, `POST /api/logout`. Todo o resto exige sessão.

## Comandos

```
npm install
npm run dev       # aplica migrations no banco local e roda em http://localhost:8787
npm run deploy    # publica na Cloudflare
npm run migrar    # aplica migrations novas no banco de produção
npm run backup    # exporta o banco de produção para backup.sql
```

## Convenções

- Todo texto da interface e mensagens de erro em português do Brasil.
- **Não usar travessão (—) em nenhum texto visível** (interface, mensagens, mensagem de WhatsApp). Usar vírgula, ponto ou dois pontos.
- Manter o frontend em arquivo único, sem framework e sem etapa de build.
- Sempre escapar dados do usuário com `esc()` antes de colocar em HTML.
- Erros da API: lançar com `falha(status, 'mensagem amigável')`. A mensagem aparece direto para o usuário.
- Formatação de dinheiro no front com `brl(centavos)`. Campos de valor usam `mascaraDinheiro()`.
- A mensagem de cobrança do WhatsApp é montada em `linkWhats()` no front e usa o nome da oficina e a chave Pix da tabela `config`.

## Testar antes de entregar

Rodar `npm run dev` e conferir no navegador: login, lançar serviço, ver a cobrança do mês, registrar pagamento parcial e total, e a tela no celular (até 820px a navegação vira barra inferior).
