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

Depois, em **Ajustes**, confira a chave Pix (aparece na fatura impressa) e cadastre o resto da equipe.

## Domínio próprio (opcional)

No painel da Cloudflare: Workers e Pages > carteira-oficina > Settings > Domains & Routes > Add > Custom domain (ex: `carteira.suaoficina.com.br`).

## Como funciona

- **Lançar serviço:** escolhe o cliente (ou cadastra na hora), data, veículo, o que foi feito e valor. O sistema já mostra em qual cobrança o serviço entra.
- **Cobranças:** lista por mês de todos os clientes, com total, pago, falta e situação. Dá para receber pagamento (total ou parcial) e exportar planilha.
- **A cobrar:** lista de quem está devendo, somando todos os meses, com os mais atrasados primeiro. Mostra há quantos dias está vencido, a última anotação de cobrança e as promessas de pagamento.
- **Receber:** o cliente paga quanto puder. O valor abate primeiro os meses mais antigos e o resto fica em aberto para depois.
- **Anotar cobrança:** registra o que foi conversado e, se quiser, o dia e o valor que o cliente prometeu pagar. O painel avisa as promessas de hoje e as não cumpridas.
- **Fatura do cliente:** detalhe do mês, botão para ligar e botão de imprimir.
- **Relatórios:** gráficos de serviços feitos x dinheiro recebido, idade da dívida, quem mais deve e pontualidade dos pagamentos, nos últimos 6 ou 12 meses. Toque numa barra para ver o valor ou use "Ver em tabela".
- **App no celular e tablet:** no Android, abra no Chrome e toque em Instalar (aparece no Painel e em Ajustes). No iPhone ou iPad, abra no Safari, toque em Compartilhar e depois em Adicionar à Tela de Início.
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
migrations/0002_anotacoes.sql Anotações de cobrança
wrangler.toml                 Configuração da Cloudflare (já com o ID do banco)
```
