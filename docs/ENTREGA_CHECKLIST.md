# Checklist de entrega — Distributed Wagering Processor

Este checklist cruza os requisitos do enunciado com o código e os testes disponíveis. “Validado” significa que existe teste automatizado ou proteção verificável no schema; não significa certificação de produção.

## Stack e estrutura

| Requisito | Evidência | Situação |
|---|---|---|
| Bun 1.x e TypeScript strict | package.json, bun.lock, tsconfig.json | Validado por configuração e comandos de build/teste. |
| NestJS, PostgreSQL e ORM permitido | package.json e src/infrastructure/persistence | MikroORM com PostgreSQL. |
| SQS por LocalStack e Docker Compose | docker-compose.yml e docker/localstack/init | Validado por integração real com LocalStack. |
| Migrations versionadas e reversíveis | src/infrastructure/persistence/migrations e test/integration/persistence/migrations.spec.ts | Aplicação, rollback e reaplicação testados. |
| Domínio separado das tecnologias externas | src/domain, src/application, src/infrastructure e src/presentation | Verificado pela organização e imports do domínio. |

## Regras financeiras e persistência

| Requisito | Evidência | Situação |
|---|---|---|
| Precisão decimal sem number para dinheiro | src/domain/money/money.ts e test/unit/domain/money/money.spec.ts | Decimal.js; contratos e persistência usam strings e NUMERIC(30,2). |
| Carteira única por jogador e moeda; saldo não negativo | Migration20261113000000_CreateWageringSchema e testes de persistência | Constraints do PostgreSQL e cenários concorrentes. |
| Concorrência isolada por carteira | PostgresWagerPersistence.findWalletForUpdate e test/integration/wagering/process-wager.spec.ts | Lock PostgreSQL por wallet; teste mantém uma carteira bloqueada e processa outra. |
| Ledger balanceado, imutável e sem movimento para LOSS/rejeição | Migration inicial e testes de domínio/integração | Constraints e triggers impedem edição, remoção, truncate e lançamento inválido. |
| OPENING e movimento inicial atômicos | OpenWallet, PostgresWalletOpeningPersistence e teste HTTP | Saldo positivo cria OPENING/crédito; saldo zero não cria movimento. |
| BET, WIN, LOSS, REFUND e ROLLBACK | WagerTransaction, ProcessWager e testes de domínio, HTTP e PostgreSQL | Regras e falhas terminais cobertas. |
| Idempotência persistente, chave global e payload conflitante | Constraint da migration, hash-wager-payload.ts e testes de wagering | Replay retorna snapshot; mesma chave com conteúdo diferente conflita. |
| Reversão única por referência e tipo | Índice único parcial e testes de reversão concorrente | Constraint de banco mais validação de domínio. |
| Atomicidade entre carteira, transação, ledger, inbox e outbox | PostgresWagerPersistence e testes de falha induzida | O rollback PostgreSQL reverte o conjunto. |
| Reconciliação sem reparo automático | ReconcileWallet e teste HTTP | Compara saldo armazenado e ledger; divergência é observável. |

## Mensageria e execução distribuída

| Requisito | Evidência | Situação |
|---|---|---|
| Inbox durável e confirmação após commit | WagerSqsConsumer, ProcessWager.executeFromInbox e teste LocalStack | Redelivery após commit sem ACK é simulada; a inbox evita segundo débito e o consumer real confirma a mensagem. |
| Retry, backoff e DLQ | test/integration/messaging/wager-sqs-consumer.spec.ts | Falha transitória induzida e redrive para DLQ testados com LocalStack. |
| Outbox transacional e publishers concorrentes | PostgresOutboxPublishing e test/integration/messaging/outbox-publisher.spec.ts | Claim concorrente, ordem, lease vencido e retry testados. O teste de recuperação usa lease vencido, não encerra um processo do sistema operacional em ponto de falha. |
| Referências fora de ordem e TTL | PendingReferenceWorker e testes de wagering | Retry durável, resolução concorrente e expiração testados. |
| 50 repetições e três instâncias | test/integration/distributed/instances.spec.ts | Três processos Bun reais, uma única movimentação e recuperação após reinício. |
| Cenário de duas apostas de 80.00 em saldo 100.00 | test/integration/http/wagering.spec.ts | Uma processada, outra rejeitada, saldo 20.00, um débito e reconciliação. |
| Consistência final saldo/ledger | Testes de aceite e distribuído | Conferida nos cenários citados; não é uma prova formal para todo estado possível. |

## HTTP, interface e operação

| Requisito | Evidência | Situação |
|---|---|---|
| Escrita, consultas paginadas, health e métricas | Controllers em src/presentation e testes HTTP | Rotas implementadas; cursores estáveis não usam OFFSET. |
| Console local em GET / | ApiActivityController e teste HTTP | Não redireciona. Buffer efêmero limitado a 500 registros por processo. |
| Painel ligado à API real | web/src/api e web/src/features | Demonstração visual para jogo, extrato e laboratório; não substitui backend nem calcula valores financeiros. |
| Segurança de ambiente de demonstração | docker-compose.yml, src/main.ts, README.md | Portas vinculadas ao loopback. Não há autenticação; configuração não deve ser exposta em rede. |
| Autenticação | ARCHITECTURE.md e ponto de extensão no controller de wagering | Não implementada conforme opção aceita pelo desafio; implantação real exige provedor de identidade externo e autorização. |
| Métricas e console de logs | src/infrastructure/observability e teste do buffer | Diagnóstico local; métricas e console reiniciam e não agregam réplicas. |
| Teste de carga | Não há script ou relatório de carga | Não implementado; diferencial opcional e nenhum throughput é alegado. |

## Documentação e revisão final

- [x] README com pré-requisitos, inicialização, execução em dois terminais, testes, escopo do painel, tecnologias e autoria declarada.
- [x] ARCHITECTURE com fluxos, invariantes, concorrência, idempotência, reversões, mensageria, autenticação e trade-offs.
- [x] Contrato OpenAPI identificado como parcial, sem sugerir que cubra todas as rotas.
- [x] Comentários iniciais em português conferidos em 115 arquivos de código/configuração; assinaturas pessoais removidas.
- [x] Estrutura DDD existente mantida; navegação explicada em README sem mover módulos sem justificativa.
- [x] Verificação final: backend `bun run check` e `bun run build` passaram; `bun run test` passou com 116 testes e 642 expectativas. No pacote web, `bun run check`, `bun test` (15 testes, 46 expectativas) e `bun run build` passaram.

## Limitações conhecidas

- O teste da janela entre commit e ACK deixa a mensagem SQS sem confirmação e torna a redelivery visível, mas não mata um processo do sistema operacional. Ele valida deterministicamente a recuperação pela inbox com PostgreSQL e LocalStack reais.
- O teste de outbox cobre claim, lease vencido e retry, mas não é teste de carga nem mede disponibilidade ou throughput de produção.
- O console HTTP armazena logs apenas na memória do processo; use a saída dos processos e coleta centralizada em uma implantação distribuída.
- A ausência de autenticação e o uso local de LocalStack são limites explícitos do escopo de demonstração.
