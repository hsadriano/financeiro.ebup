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
- Mensagens de voz no chat, transcritas antes da interpretação financeira.
- Upload de imagens/PDFs/comprovantes para iniciar o fluxo de conferência.
- OCR de imagens com OpenAI quando `OPENAI_API_KEY` estiver configurada.
- Dashboard mensal com receitas, despesas, resultado, contas a pagar e categorias.
- Área de configurações para editar perfil, senha, controle compartilhado e carteiras.
- Carteiras vinculáveis aos lançamentos, com tipo, saldo inicial e saldo calculado.
- Navegação mobile com Início, Extrato, Registrar, Contas e Assistente.
- Conferência isolada por captura, sem misturar rascunhos anteriores.
- Comprovantes vinculados aos lançamentos, avisos de leitura e conferência de possíveis duplicidades.
- Confirmação da captura inteira em uma transação de banco, sem salvar apenas parte de uma série.
- Registro manual sem IA, com repetição mensal e ajuste ao último dia do mês.
- Edição de lançamentos salvos, registro de pagamento/recebimento e remoção com desfazer.
- Alteração de valor/carteira em seleção ou série: só este, este e os próximos, ou todos.
- Gestão de parcelas em aberto: cancelamento e ajuste de vencimentos com prévia e proteção do histórico pago.
- Movimentação de lançamentos entre espaços, individualmente, em seleção ou pelo chat.
- Armazenamento em MariaDB quando `.env` estiver configurado.
- Fallback local em `data/finance.json` quando não houver configuração de banco.
- Schema MariaDB em `database/schema.sql`.

## Prévia de usabilidade

```bash
pnpm run preview:ux
```

Abre uma prévia isolada em http://127.0.0.1:3021 com dados fictícios em memória. Não lê o
`.env`, não acessa o banco e não chama serviços de IA. Os dados são reiniciados ao
encerrar o processo. Use `PORT=3022 pnpm run preview:ux` se a porta estiver ocupada.

No app real, Início mostra valores realizados no mês e próximos vencimentos.
Contas futuras não entram como dinheiro já gasto/recebido. Toda captura fica como
rascunho até a confirmação. Ao repetir um lançamento já realizado manualmente,
somente a primeira ocorrência é realizada; as próximas ficam em aberto.

Os ícones Lucide 0.468.0 são distribuídos localmente em `public/lucide.min.js`,
preservando a licença do pacote e sem depender de CDN no celular.

## Conferência inteligente

Na conferência e nos detalhes, **Ver comprovante** abre o arquivo vinculado. Imagens
também mostram uma miniatura; se ela falhar, o link continua disponível. Quando um
upload gera um lançamento, o vínculo passa a ser permanente. A migração recupera vínculos
antigos a partir dos recibos de captura quando arquivo e lançamento ainda estão
no mesmo espaço. Arquivos antigos sem uma associação segura não são vinculados por
suposição de nome ou valor.

Antes de salvar, leituras com confiança informada pelo extrator abaixo de 0,85
destacam valor, data e situação para conferência. Categoria Outros sugerida pela IA
também recebe aviso. Esse indicador não é uma probabilidade calibrada nem substitui
a conferência do usuário; registros manuais não recebem esses avisos de extração.

Possíveis duplicados são procurados apenas no espaço atual. A comparação usa o
mesmo conteúdo de arquivo ou valor e data com descrição/estabelecimento compatíveis.
Receitas e despesas distintas não são confundidas pelo valor, ocorrências da mesma
série são ignoradas e lançamentos descartados ficam fora da comparação. Trata-se de
um alerta, não de uma garantia de detectar toda repetição ou de uma exclusão automática.

Ao encontrar candidatos, a captura apresenta os registros e pede confirmação
explícita para salvar mesmo assim. O servidor verifica novamente os candidatos;
se houver um novo registro que não estava na conferência, nada da captura é salvo
até a revisão. A confirmação em lote preserva datas e contas futuras e pode ser
repetida sem salvar os mesmos rascunhos outra vez.

## Mover lançamentos entre espaços

Nos detalhes de um lançamento, use **Mover para outro espaço**. No Extrato,
**Selecionar** permite mover vários de uma vez. A tela apresenta o total antes da
confirmação e permite escolher a carteira no destino. No chat do espaço de origem,
também é possível pedir: `Mova as mensalidades da escola para o espaço Casa`.

Selecionar uma ocorrência move a série recorrente inteira, inclusive rascunhos
vinculados, preservando IDs, valores, datas e situação. É necessário ter permissão
de edição nos dois espaços. Categorias são associadas pelo nome e tipo, e criadas
no destino quando necessário. Por padrão, carteiras são associadas por nome único;
se não houver correspondência, o item fica sem carteira, com aviso na prévia.

Comprovantes vinculados acompanham os registros quando todos os itens
ativos daquele documento estiverem no destino. Arquivos antigos sem esse vínculo
permanecem no espaço original. O objeto no armazenamento não é renomeado nem
duplicado. A operação não cria novos lançamentos e não troca o espaço aberto.

Para testar as duas implementações com tabelas temporárias no MariaDB local:

```bash
FINUP_TEST_MARIADB=1 node --test test/transaction-move-mariadb.test.js
```

Esse teste exige `DB_HOST` local, usa o `.env` existente e não altera as tabelas
permanentes do app.

## Gestão de recorrências

Nos detalhes de um lançamento recorrente, **Gerenciar série** permite alterar o dia
de vencimento ou cancelar parcelas. É possível selecionar somente a ocorrência
escolhida, ela e as próximas pela ordem da série, ou todas as parcelas em aberto.
Esse fluxo também fica disponível ao editar uma captura recorrente ainda pendente.

Somente registros agendados e rascunhos com vencimento participam dessas operações.
Pagamentos, recebimentos e rascunhos já informados como realizados não são alterados.
A troca do dia mantém o mês de cada parcela e usa seu último dia quando necessário,
incluindo fevereiro em anos bissextos. Valores, carteiras, categorias, IDs e vínculos
com comprovantes são preservados.

Antes de aplicar, o servidor devolve a lista de parcelas e datas afetadas. Se houver
uma mudança desde essa prévia, é necessário conferi-la novamente. Cancelamentos
exigem confirmação adicional; os registros são retirados das listas sem apagar os
comprovantes ou renumerar as parcelas restantes. Como as séries atuais são finitas,
encerrá-las significa cancelar as ocorrências em aberto já criadas, não interromper
um agendador automático. Alterações de valor/carteira continuam no fluxo já existente.

As operações exigem permissão de edição no espaço atual e são aplicadas em uma única
transação. Uma falha durante a alteração não salva apenas parte da série. Nesta
etapa, o gerenciamento é feito pela interface; não há novo comando de cancelamento
ou vencimento no chat.

## Rascunhos e reenvio

- Texto, mensagem do chat e formulário manual são recuperados do IndexedDB após reabrir o app e autenticar.
- Cada usuário e espaço tem seus próprios rascunhos e envios; nenhuma senha ou chave de API é guardada nesse armazenamento.
- Antes de transmitir, o app guarda a tentativa com um identificador único, inclusive o anexo ou áudio já finalizado.
- Se a resposta falhar, a área **Neste aparelho** permite retomar explicitamente a mesma tentativa.
- O servidor grava o recibo e as alterações financeiras na mesma transação InnoDB. Repetir uma tentativa concluída retorna o resultado anterior, sem chamar a IA novamente nem criar novos lançamentos.
- Há limite de 20 tentativas por espaço e 50 MB de anexos locais. Navegadores sem IndexedDB mantêm dados somente na sessão e informam essa limitação.
- Sair da conta solicita confirmação se houver dados locais e apaga as cópias daquele usuário. Remover uma tentativa local não remove dados já recebidos pelo servidor.

Não há sincronização automática em segundo plano nem funcionamento completo sem rede
ao abrir o app do zero. A retomada ocorre com o app aberto e a sessão autenticada.
Limpar dados do navegador ou desinstalar o app pode apagar cópias ainda não enviadas.

Para simular uma falha depois de processar o primeiro envio, sem tocar em dados reais:

```bash
PREVIEW_DROP_ONCE=1 pnpm run preview:ux
```

O PHP usa `finup_schema_versions` para executar a migração uma vez por versão e
evitar DDL durante cada requisição. Toda mudança futura no schema deve atualizar
a versão em `ensure_schema`, além do schema SQL e da inicialização Node.

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
OPENAI_MODEL=gpt-4.1-nano
OPENAI_CHAT_MODEL=gpt-4.1-mini
OPENAI_OCR_MODEL=gpt-4.1-nano
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
OPENAI_BASE_URL=https://api.openai.com/v1
```

Quando a chave estiver presente, o chat usa a Responses API com memória curta e ferramentas para propor lançamentos e consultar os dados do controle financeiro ativo. O modelo de chat pode ser mais capaz sem aumentar o custo do OCR, que continua usando o modelo configurado em `OPENAI_OCR_MODEL`. Se a API falhar, o app continua funcionando com o parser local.

As mensagens de voz são limitadas a 60 segundos. O áudio é enviado somente para transcrição e não é armazenado no banco nem no bucket; o histórico guarda apenas o texto transcrito.

## Leitura de comprovantes e PDFs

Com `OPENAI_API_KEY` configurada, imagens e PDFs válidos são analisados automaticamente. Se a IA identificar uma única transação com segurança, o app cria um lançamento pendente para revisão; nada entra nos totais antes da confirmação. Boletos e contas usam o vencimento como data da transação. Extratos com várias compras não são desmembrados automaticamente.

PDFs são enviados como arquivo à Responses API com detalhe visual alto para permitir leitura de documentos digitalizados e letras pequenas. O conteúdo é processado pela IA configurada em `OPENAI_OCR_MODEL` e pode gerar custo conforme as páginas; a resposta não fica armazenada pela API (`store: false`). O limite de upload do app continua em 20 MB. Sem chave de IA, o arquivo é salvo normalmente para consulta, mas a leitura automática não ocorre.

## Google Cloud Storage

Para armazenar uploads no bucket do Google Cloud Storage, configure:

```text
GOOGLE_CLOUD_PROJECT_ID=atzcredja
GOOGLE_CLOUD_BUCKET_NAME=atz-finup
GOOGLE_CLOUD_CREDENTIALS_FILE=
```

Quando `GOOGLE_CLOUD_CREDENTIALS_FILE` estiver vazio, o app procura automaticamente o JSON da service account em:

```text
app/config/keys/*.json
```

Os arquivos `.json` dessa pasta ficam fora do Git. Se um bucket estiver configurado
mas as credenciais não existirem, o envio informa falha. Sem bucket configurado,
os arquivos são armazenados em `uploads/`. O Apache bloqueia acesso HTTP direto
às pastas internas e a `uploads/`; comprovantes são servidos pela API autenticada.

## Recuperação de senha por e-mail

Para habilitar o fluxo "Esqueci minha senha", configure SMTP no `.env`:

```text
MAIL_HOST=smtp.hostinger.com
MAIL_PORT=465
MAIL_USERNAME=nao-responda@ebup.com.br
MAIL_PASSWORD=sua_senha_smtp
MAIL_FROM_EMAIL=nao-responda@ebup.com.br
MAIL_FROM_NAME=Finup
```

O link enviado por e-mail expira em 1 hora e o token é salvo no banco apenas como hash.

## Exemplos de mensagens

```text
Paguei R$ 89,90 no mercado hoje no pix
Recebi R$ 5000 de salário em 05/07
Boleto aluguel R$ 1800 vence 10/08
Gastei 42,50 com Uber ontem no cartão
```

## Validação e próximos passos

Execute `pnpm test` e `php -l api.php` antes de publicar. Os testes cobrem
interpretação, captura isolada, recorrência, filtros, edição, duplicidades e os
contratos de conferência das implementações Node e PHP.

`FINUP_TEST_MARIADB=1 pnpm test` também valida o banco e os endpoints reais dos dois
backends. Esses testes exigem MariaDB local, usam tabelas temporárias e um banco
descartável com nome exclusivo, removido ao terminar. Não alteram os registros do
banco do app nem chamam os serviços de IA.

## Fila de evolução

A conferência inteligente e a gestão de recorrências são etapas concluídas desta rodada. A ordem
planejada para as seguintes é:

1. Alertas de contas próximas e atrasadas, pagamento e recebimento rápidos.
2. Fluxo de caixa futuro, previsão de saldo por carteira e orçamento por categoria.
3. Primeiro uso guiado para espaços, carteiras e saldos; login Google continua adiado.
4. Abertura e registro sem conexão, com sincronização posterior.
5. Preparação para lançamento: privacidade, consentimento para IA, exportação/exclusão de dados, permissões, credenciais, backups, testes físicos e pacote nativo.

Antes das lojas: testar câmera, microfone, teclado e safe areas em aparelhos físicos,
adicionar consentimento de processamento por IA, exclusão de conta/dados e o pacote
nativo. O reenvio com identificador, recuperação de rascunhos e leitura de PDF já
estão implementados. A abertura sem rede e a sincronização em segundo plano continuam
como etapas futuras.
