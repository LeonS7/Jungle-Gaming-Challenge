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

A raiz da API (**http://127.0.0.1:3000/**) abre o console local de atividade. Ele consulta os registros recentes do processo e não redireciona ao painel. Os registros ficam limitados aos 500 mais recentes, somem no reinício e não são compartilhados entre instâncias. Requisições HTTP são registradas sem corpo, cabeçalhos nem parâmetros; logs da aplicação também podem conter identificadores operacionais. Para consultar a API diretamente:

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

- A aplicação não implementa autenticação. A API, o banco, o LocalStack e o servidor de desenvolvimento ficam limitados ao loopback para uso local. Outros processos da mesma máquina ainda podem acessar a API; esse arranjo não é adequado para exposição em rede.
- Não há autenticação artesanal. Para uma implantação real, integrar um provedor de identidade externo e aplicar autorização aos endpoints antes de abrir acesso de rede.
- O console de atividade e as métricas são locais à instância. O console mantém no máximo 500 entradas em memória; métricas também reiniciam com o processo.
- LocalStack é a dependência de SQS usada na execução local e nos testes; a configuração de produção da AWS não faz parte deste projeto.
- Os testes concorrentes são evidências de correção dos cenários exercitados, não ensaios de carga nem metas de throughput.

## Autoria e ferramentas de desenvolvimento

O projeto foi conduzido por **Leonardo de Souza da Luz**. Codex foi utilizado de forma consciente como ferramenta auxiliar para análise, revisão, documentação e aceleração de tarefas de desenvolvimento. As decisões de domínio e as funcionalidades financeiras centrais do desafio são de autoria do responsável pelo projeto; o resultado deve ser apresentado com compreensão das escolhas e das evidências registradas.

## Arquivos de referência

- **ARCHITECTURE.md**: decisões, fluxos, invariantes e trade-offs.
- **CHALLENGE.md**: enunciado técnico usado na avaliação.
- **docs/openapi.yaml**: contrato documentado das rotas HTTP implementadas.
