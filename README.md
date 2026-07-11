# Finance Assistant MVP

Primeira versão de um assistente financeiro pessoal com chat, upload de comprovantes e relatórios.

## Rodando localmente

```bash
cp .env.example .env
node src/server.js
```

Depois abra:

```text
http://localhost:3020
```

Para testar pelo celular na mesma rede, rode:

```bash
pnpm run dev:lan
```

Depois abra no celular usando o IP da maquina na rede:

```text
http://SEU_IP_LOCAL:3020
```

Em hospedagem Node.js, configure `HOST=0.0.0.0`, `PORT` conforme a porta liberada pelo provedor e as variaveis `DB_*` no painel do servidor.

Em hospedagem PHP/Apache, como Hostinger compartilhada, o projeto tambem roda direto em `public_html` usando `api.php` e `.htaccess`. Nesse modo nao precisa iniciar Node: basta configurar o `.env` e garantir que o banco MariaDB exista.

## O que já existe

- Chat para registrar despesas, receitas e contas a pagar por texto.
- Upload de imagens/PDFs/comprovantes para iniciar o fluxo de conferência.
- Dashboard mensal com receitas, despesas, resultado, contas a pagar e categorias.
- Armazenamento em MariaDB quando `.env` estiver configurado.
- Fallback local em `data/finance.json` quando não houver configuração de banco.
- Schema MariaDB em `database/schema.sql`.

## Banco de dados

Configure o arquivo `.env`:

```text
DB_HOST=localhost
DB_PORT=3306
DB_NAME=finance_assistant
DB_USER=root
DB_PASS=sua_senha
```

Ao iniciar, o app cria as tabelas necessárias se elas ainda não existirem.

## Deploy simples em servidor Node.js

```bash
git clone https://github.com/hsadriano/financeiro.ebup.git
cd financeiro.ebup
pnpm install --prod
cp .env.example .env
pnpm start
```

No servidor, preencha o `.env` real com os dados do MariaDB antes de iniciar.

## Deploy simples em servidor PHP/Apache

```bash
git clone https://github.com/hsadriano/financeiro.ebup.git public_html
cd public_html
cp .env.example .env
```

Depois preencha o `.env` real. O `.htaccess` serve a interface em `public/` e encaminha `/api/*` para `api.php`.

## Interpretação com IA

O app usa um parser local por regras como fallback. Para melhorar o entendimento de texto livre, configure:

```text
OPENAI_API_KEY=sua_chave
OPENAI_MODEL=gpt-4.1-mini
OPENAI_BASE_URL=https://api.openai.com/v1
```

Quando a chave estiver presente, o chat tenta extrair os dados financeiros pela API. Se a API falhar, o app continua funcionando com o parser local.

## Exemplos de mensagens

```text
Paguei R$ 89,90 no mercado hoje no pix
Recebi R$ 5000 de salário em 05/07
Boleto aluguel R$ 1800 vence 10/08
Gastei 42,50 com Uber ontem no cartão
```

## Próximos passos técnicos

1. Trocar o storage JSON pelo MariaDB usando o schema em `database/schema.sql`.
2. Adicionar OCR real para imagens/PDFs.
3. Criar fluxo de confirmação antes de salvar lançamentos de baixa confiança.
4. Adicionar autenticação e criptografia de dados sensíveis.
