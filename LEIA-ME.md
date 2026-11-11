# Carteira de Clientes da Oficina

Sistema online para lançar os serviços feitos para cada cliente e cobrar tudo junto no mês seguinte.

**Regra de cobrança:** todo serviço feito do dia 1 ao último dia do mês entra na fatura do cliente daquele mês, que vence **entre o dia 5 e o dia 10 do mês seguinte**. Os dias podem ser alterados em Ajustes.

Roda na Cloudflare (Worker + banco D1). O banco `carteira-oficina` já foi criado e estruturado na sua conta.

## Publicar (primeira vez)

No Windows, abra o terminal dentro desta pasta e rode:

```
npm install
npx wrangler login      (só se ainda não estiver logado)
npx wrangler deploy
```

O terminal mostra o endereço, algo como `https://carteira-oficina.SEU-USUARIO.workers.dev`.

**Abra o endereço logo em seguida.** O primeiro acesso pede para criar o usuário administrador. Quem abrir primeiro vira o administrador, por isso faça isso assim que publicar.

Depois, em **Ajustes**, confira a chave Pix (vai na mensagem de cobrança) e cadastre o resto da equipe.

## Domínio próprio (opcional)

No painel da Cloudflare: Workers e Pages > carteira-oficina > Settings > Domains & Routes > Add > Custom domain (ex: `carteira.suaoficina.com.br`).

## Como funciona

- **Lançar serviço:** escolhe o cliente (ou cadastra na hora), data, veículo, o que foi feito e valor. O sistema já mostra em qual cobrança o serviço entra.
- **Cobranças:** lista por mês de todos os clientes, com total, pago, falta e situação. Dá para receber pagamento (total ou parcial) e exportar planilha.
- **Fatura do cliente:** detalhe do mês, botão para cobrar no WhatsApp com a mensagem pronta (lista dos serviços, total, prazo e Pix) e botão de imprimir.
- **Situações:** Mês corrente (ainda acumulando), A vencer, Vence agora (dentro do dia 5 a 10), Vencida, Paga.
- **Acesso:** login com usuário e senha. Administrador mexe em Ajustes e na equipe; o restante da equipe lança serviços e recebe pagamentos.

## Segurança

- Senhas guardadas com hash PBKDF2 (ninguém consegue ler a senha no banco).
- Sessão em cookie protegido (HttpOnly, Secure), válida por 30 dias.
- Bloqueio de 15 minutos após 8 tentativas erradas de login.
- Pedidos vindos de outros sites são recusados.

## Comandos úteis

| Comando | Para quê |
|---|---|
| `npm run deploy` | Publicar alterações |
| `npm run backup` | Baixar uma cópia do banco (backup.sql) |
| `npm run dev` | Rodar no computador para testar (banco local separado) |

A Cloudflare também guarda o histórico do banco por 30 dias (Time Travel), dá para voltar a qualquer ponto pelo comando `npx wrangler d1 time-travel restore carteira-oficina --timestamp=...`.

## Estrutura

```
src/index.js                  API e regras (login, clientes, serviços, faturas, pagamentos)
public/index.html             Telas do sistema
migrations/0001_inicial.sql   Estrutura do banco
wrangler.toml                 Configuração da Cloudflare (já com o ID do banco)
```
