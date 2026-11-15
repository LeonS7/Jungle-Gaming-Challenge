# Jungle Gaming Challenge — Processador Distribuído de Apostas

Implementação do desafio **Distributed Wagering Processor**, da Jungle Gaming. O projeto demonstra como processar transações financeiras de apostas sob concorrência, mensagens repetidas e falhas de infraestrutura, mantendo PostgreSQL como autoridade para saldo e idempotência.

> **Escopo da interface web:** o painel em **web/** é uma ferramenta local de demonstração e testes visuais ligada à API real. Ele não implementa regras financeiras, não calcula saldos e não representa uma plataforma de cassino pronta para produção.

## O que está implementado

- Domínio de dinheiro decimal, carteiras, transações e ledger imutável.
- API HTTP para carteiras, **BET**, **WIN**, **LOSS**, **REFUND**, **ROLLBACK**, consultas e reconciliação.
- Idempotência persistida no PostgreSQL, com chave global única e rejeição de payload divergente.
- Concorrência protegida por lock da carteira e constraints no banco; carteiras diferentes podem avançar em paralelo.
- Atomicidade entre saldo, transação, ledger, inbox e outbox conforme o fluxo.
- Consumidor SQS com inbox, redelivery segura, retry e DLQ; publisher da outbox com lease persistido e entrega *at-least-once*.
- Worker para resolver transações que aguardam uma referência fora de ordem.
- Health checks, métricas Prometheus e console local de atividade em **GET /**.
- Painel visual com as áreas **Jogo**, **Extrato** e **Laboratório de Testes**, cenários guiados e chamadas à API real.
- Benchmark local configurável com cenários distribuídos, disputa de carteira, idempotência e pressão/drenagem da outbox; gera relatórios JSON e Markdown.
- Recuperação da rodada ativa e do retry incerto após navegação ou recarga, sempre consultando a API como fonte do estado financeiro.

## Tecnologias

| Área | Tecnologia |
|---|---|
| Runtime, dependências e testes | Bun 1.x |
| Linguagem | TypeScript em modo estrito |
| API | NestJS |
| Persistência | PostgreSQL e MikroORM |
| Precisão monetária | decimal.js e colunas PostgreSQL NUMERIC(30,2) |
| Mensageria local | AWS SQS via LocalStack |
| Interface de demonstração | Vue 3, TypeScript e Vite |
| Ambiente local | Docker Compose |

## Requisitos para executar

- Bun 1.x. A versão usada no projeto está registrada nos arquivos package.json e nos arquivos de lock.
- Docker Desktop em execução, com Docker Compose.
- Portas locais disponíveis: 3000 (API), 5173 (painel), 5432 (PostgreSQL) e 4566 (LocalStack). As portas publicadas ficam no loopback.

Confira as ferramentas no PowerShell:

    bun --version
    docker compose version
    docker info

## Executar o backend e a infraestrutura

No diretório raiz do repositório, em um terminal PowerShell:

    Copy-Item .env.example .env
    bun install --frozen-lockfile
    docker compose up -d postgres localstack
    bun run db:migrate
    bun run start

A cópia de .env.example é necessária somente na primeira execução. Confira **docker compose ps** para acompanhar PostgreSQL e LocalStack. **bun run start** compila o backend e inicia a API em **http://127.0.0.1:3000**.

A raiz da API (**http://127.0.0.1:3000/**) abre o console local de atividade. Ele consulta os registros recentes do processo e não redireciona ao painel. O buffer mantém no máximo 500 registros e descarta os mais antigos quando chegam novos; se o navegador ficar para trás ou a API reiniciar, o console salta para os registros mais recentes e continua atualizando. O histórico some no reinício e não é compartilhado entre instâncias. Requisições HTTP são registradas sem corpo, cabeçalhos nem parâmetros; logs da aplicação também podem conter identificadores operacionais. Para consultar a API diretamente:

    Invoke-RestMethod http://127.0.0.1:3000/health/live
    Invoke-RestMethod http://127.0.0.1:3000/health/ready

## Executar o painel visual

Com a API e os serviços locais em execução, abra **outro** terminal PowerShell:

    Set-Location web
    Copy-Item .env.example .env
    bun install --frozen-lockfile
    bun run dev

Abra **http://127.0.0.1:5173**. O painel usa o proxy local para acessar a API em 127.0.0.1:3000. A área Jogo envia operações reais; o Extrato busca o histórico persistido; o Laboratório consulta serviços e executa operações de demonstração. Cenários guiados criam carteiras e gravações permanentes no banco: não há botão de exclusão nem redefinição do ledger.

## Executar verificações e testes

Com Docker e os serviços PostgreSQL e LocalStack iniciados, a partir da raiz:

    bun run check
    bun run build
    bun run test

A suíte usa PostgreSQL e LocalStack reais para cenários de integração, concorrência, inbox, outbox, retry e DLQ. Para executar somente as integrações:

    bun run test:integration

Para verificar o painel, em outro terminal:

    Set-Location web
    bun run check
    bun test
    bun run build

Os testes criam schemas e filas temporários e os removem ao terminar. Eles não substituem os dados da aplicação configurados em .env.

## Executar o teste de carga

O benchmark usa a API, o PostgreSQL e o LocalStack reais da execução local. Ele não substitui integrações por mocks e não altera as regras financeiras. Antes de iniciar, confirme que `http://127.0.0.1:3000` aponta para esta execução local, que o backend está pronto e que há espaço para os registros adicionais.

Na raiz do repositório, execute:

    bun run test:load

O comando mostra um aviso e pede confirmação porque cria carteiras, transações, lançamentos no ledger e eventos permanentes. Em terminal automatizado, a confirmação precisa ser explícita:

    bun run test:load -- --yes --scenario contention --concurrency 10,25,50

Os cenários são `distributed`, `contention`, `idempotency` e `outbox`; `all` executa todos. A configuração também aceita `--api-url`, `--duration-seconds`, `--warmup-seconds`, `--repetitions`, `--wallet-count`, `--operations-per-wallet`, `--metrics-interval-seconds`, `--http-timeout-ms` e `--outbox-drain-timeout-seconds`. O runner aceita somente API, PostgreSQL e endpoint SQS locais (`localhost`, `127.0.0.1` ou `::1`); destinos remotos são recusados.

No modo `all`, o cenário `outbox` é executado antes dos demais para isolar a drenagem do backlog criado pelo próprio benchmark. Ele usa no máximo 10 operações por carteira e 120 por execução; o cenário `distributed` mantém o volume definido em `--operations-per-wallet`.

Os relatórios de cada execução ficam em `artifacts/load-tests/<execution-id>/summary.json` e `report.md`. O diretório é ignorado pelo Git para evitar publicar grandes relatórios locais ou dados operacionais. Nenhuma execução apaga dados financeiros.

O mesmo runner está disponível no **Laboratório de Testes** enquanto o Vite estiver rodando com `bun run dev` em `web/`. A tela permite selecionar cenário e parâmetros, pede confirmação antes de iniciar e exibe andamento, resultados e links para os relatórios. O middleware local inicia o runner em um processo Bun separado; erros detalhados aparecem no terminal do Vite. O controle existe somente no servidor local de desenvolvimento, vinculado ao loopback; não faz parte da API NestJS nem do build de produção.

O benchmark reporta latências observadas (mínima, média, máxima e p50/p95/p99), throughput HTTP e financeiro separados, erros operacionais, rejeições de negócio, replays, conflitos e métricas da outbox. Percentis usam nearest-rank. Ver [docs/LOAD_TEST_RESULTS.md](docs/LOAD_TEST_RESULTS.md) e [test/load/README.md](test/load/README.md) para metodologia e parâmetros.

Os resultados descrevem apenas a máquina e o ambiente local usados; não são uma meta de RPS nem uma garantia de capacidade em produção.

## Contrato HTTP resumido

| Método e rota | Uso |
|---|---|
| POST /wallets | Abre carteira e, para saldo inicial positivo, registra OPENING e crédito inicial. |
| GET /wallets/:walletId | Consulta carteira e saldo atual. |
| GET /wallets/:walletId/ledger | Consulta ledger imutável por páginas. |
| GET /wallets/:walletId/transactions | Consulta histórico de transações por páginas. |
| POST /wagering/transactions | Processa BET, WIN, LOSS, REFUND ou ROLLBACK; exige Idempotency-Key. |
| GET /wagering/transactions/:transactionId | Consulta pelo identificador interno. |
| GET /providers/:providerId/wagering/transactions/:externalTransactionId | Consulta pela identidade externa do provedor. |
| POST /wallets/:walletId/reconciliation | Compara saldo gravado com o saldo reconstruído do ledger. |
| GET /health/live e GET /health/ready | Verifica processo e dependências. |
| GET /metrics | Expõe métricas Prometheus. |
| GET / e GET /activity?after=... | Abre o console e consulta atividade recente desta instância. |

Paginação aceita cursor e limit; o padrão é 50 registros e o máximo é 100. Valores monetários entram e saem como strings decimais com duas casas. O contrato OpenAPI em **docs/openapi.yaml** cobre as rotas HTTP de carteiras, wagering, consultas, saúde, métricas e console de atividade.

## Regras financeiras e decisões importantes

- **BET** debita; **WIN** e **REFUND** creditam; **ROLLBACK** inverte o movimento da transação referenciada; **LOSS** registra o resultado sem alterar saldo ou ledger.
- **REFUND** e **ROLLBACK** precisam de referência processada válida, mesmo provedor, jogador, carteira, rodada, valor e moeda. Uma referência ainda não disponível fica pendente e é reavaliada pelo worker.
- Uma chave idêntica com os mesmos dados devolve o resultado persistido; a mesma chave com dados diferentes conflita. A constraint é global e vive no PostgreSQL, não na memória do processo nem no FIFO.
- O lock é por carteira. Saldo, ledger, transação e outbox compartilham o mesmo commit financeiro; a inbox também participa desse commit na entrada SQS. O publisher envia somente eventos já confirmados no banco.
- A entrega da outbox é *at-least-once*: consumidores de eventos precisam tratar o mesmo eventId de forma idempotente.
- Reconciliação informa diferenças, mas não corrige automaticamente registros financeiros.
- A rodada ativa e o retry do painel guardam apenas a identidade e o payload necessário no navegador; a aplicação sempre confirma status, saldo e histórico consultando a API.

## Navegação pelo código

    src/
      domain/          regras e modelos financeiros sem dependências de infraestrutura
      application/     casos de uso e portas para persistência e observabilidade
      infrastructure/ PostgreSQL, migrations, SQS, workers e métricas
      presentation/   controladores HTTP, validação e console de atividade
      config/          leitura e validação da configuração
      main.ts          inicialização do NestJS
    test/
      unit/            regras de domínio e utilitários isolados
      integration/     PostgreSQL, LocalStack, HTTP, concorrência e recuperação após queda de processo
    web/
      src/api/         cliente HTTP do painel
      src/features/    telas de Jogo, Extrato, Carteiras e Laboratório
      test/            contratos do cliente e regras locais de apresentação
    docker/            configuração de inicialização das filas do LocalStack
    docs/              contrato OpenAPI e checklist da entrega

As migrations são versionadas em **src/infrastructure/persistence/migrations**. Para aplicar alterações de schema, use **bun run db:migrate**. **bun run db:migrate:down** reverte a última migration e remove os objetos e dados abrangidos por ela; use somente em um banco descartável ou depois de proteger os dados necessários.

## Limites e segurança

- A aplicação não implementa autenticação porque esse item não recebe pontos no desafio e o timebox foi priorizado para correção financeira, concorrência e idempotência. Não há usuários/senhas locais; todos os endpoints HTTP estão sem autenticação nesta demonstração.
- A API, o banco, o LocalStack e o servidor web ficam limitados ao loopback. Isso impede acesso pela rede, mas outros processos da máquina ainda podem chamar a API; não exponha esta configuração.
- Para uma implantação real, integrar um IdP OIDC externo, como Keycloak ou Zitadel, proteger endpoints de negócio com guard NestJS e autorizar `providerId`/carteiras pela identidade verificada. Health checks permanecem públicos; o desenho e os pontos de extensão estão em **ARCHITECTURE.md**.
- Mensagens SQS seguem pelo canal interno confiável, sem autenticação HTTP, e continuam sujeitas às validações do parser, domínio e banco. Em AWS, restrinja produtores com IAM.
- O console de atividade e as métricas são locais à instância. O console mantém no máximo 500 entradas em memória; métricas também reiniciam com o processo.
- LocalStack é a dependência de SQS usada na execução local e nos testes; a configuração de produção da AWS não faz parte deste projeto.
- Os testes concorrentes são evidências de correção dos cenários exercitados, não ensaios de carga nem metas de throughput.
- Mensagens SQS válidas que esgotam cinco entregas são persistidas como `FAILED` com o código `PROCESSING_RETRIES_EXHAUSTED`, junto com a conclusão da inbox e sem movimento no saldo ou ledger; a mensagem também segue para a DLQ. Se o PostgreSQL estiver indisponível durante esse registro final, a DLQ preserva a mensagem, mas não há como garantir uma linha `FAILED` no banco.

## Autoria e ferramentas de desenvolvimento

O projeto foi conduzido por mim **Leonardo de Souza da Luz**. Codex foi utilizado de forma consciente como ferramenta auxiliar para análise, revisão, documentação e aceleração de tarefas de desenvolvimento. As decisões de domínio e as funcionalidades financeiras centrais do desafio são de autoria do responsável pelo projeto; o resultado deve ser apresentado com compreensão das escolhas e das evidências registradas.

## Arquivos de referência

- **ARCHITECTURE.md**: decisões, fluxos, invariantes e trade-offs.
- **CHALLENGE.md**: enunciado técnico usado na avaliação.
- **docs/openapi.yaml**: contrato documentado das rotas HTTP implementadas.
