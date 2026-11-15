# Benchmark do processador de apostas

## Objetivo

O benchmark mede a API HTTP real do projeto sob carga local. Ele exercita operações financeiras reais e valida saldo, ledger, eventos e estado da outbox no PostgreSQL. Não modifica as regras do domínio e não usa mocks como substituição do PostgreSQL ou do LocalStack.

## Pré-requisitos

1. Copie `.env.example` para `.env` na raiz e configure somente os serviços locais.
2. Inicie PostgreSQL e LocalStack com `docker compose up -d postgres localstack`.
3. Aplique migrations com `bun run db:migrate`.
4. Inicie a API e seus workers com `bun run start`.
5. Confira `GET /health/ready` e confirme que a API está em `127.0.0.1`.

O runner verifica se a URL da API, o host PostgreSQL e o endpoint SQS apontam para loopback (`localhost`, `127.0.0.1` ou `::1`). Endereços remotos e endpoints SQS HTTPS são recusados antes da leitura do banco ou da criação de carteiras. Nunca aponte o teste a produção, ambiente compartilhado ou proxy remoto.

## Execução

Na raiz do projeto:

```powershell
bun run test:load
```

O runner pergunta se pode criar registros financeiros permanentes. Em modo não interativo, passe `--yes` depois de revisar a configuração e o destino:

```powershell
bun run test:load -- --yes --scenario distributed --duration-seconds 10 --concurrency 10,25
```

Para consultar as opções:

```powershell
bun run test:load -- --help
```

O comando padrão executa os quatro cenários com concorrência `10,25,50`, uma repetição, até 10 segundos de carga por cenário e aquecimento de 2 segundos. No modo `all`, a outbox é executada primeiro para medir sua drenagem sem o backlog produzido pelos demais cenários. Os valores limitam a carga padrão; aumente-os explicitamente apenas quando o ambiente local puder absorver as gravações. `operations-per-wallet` limita o cenário distribuído e a duração é seu teto.

## Cenários

- **distributed:** distribui BETs de `0.01` entre carteiras exclusivas com saldo pré-carregado suficiente para o máximo configurado.
- **contention:** envia BETs de `80.00` simultâneas para uma carteira com saldo `100.00`; espera uma operação processada e o restante rejeitado por saldo insuficiente.
- **idempotency:** envia a mesma chave e payload em paralelo e, depois, o mesmo identificador/chave com payload divergente; espera um único processamento, replays e HTTP 409 `IDEMPOTENCY_CONFLICT`.
- **outbox:** gera BETs distribuídas, mede eventos pendentes/publicados e aguarda a drenagem dentro do limite. Para manter a demonstração reproduzível, ele usa no máximo 10 operações por carteira e 120 operações por execução, mesmo se `operations-per-wallet` for maior. O cenário distribuído continua usando o volume configurado.

O aquecimento envia LOSS de `0.01` para uma carteira de saldo zero. As respostas de aquecimento não entram nas latências/throughput principais, mas seus registros também ficam persistidos e são incluídos na validação financeira.

## Opções

| Argumento | Variável de ambiente | Padrão |
|---|---|---:|
| `--api-url` | `LOAD_TEST_API_URL` | `http://127.0.0.1:3000` |
| `--scenario` | `LOAD_TEST_SCENARIO` | `all` |
| `--duration-seconds` | `LOAD_TEST_DURATION_SECONDS` | `10` |
| `--warmup-seconds` | `LOAD_TEST_WARMUP_SECONDS` | `2` |
| `--repetitions` | `LOAD_TEST_REPETITIONS` | `1` |
| `--concurrency` | `LOAD_TEST_CONCURRENCY` | `10,25,50` |
| `--wallet-count` | `LOAD_TEST_WALLET_COUNT` | `12` |
| `--operations-per-wallet` | `LOAD_TEST_OPERATIONS_PER_WALLET` | `100` |
| `--metrics-interval-seconds` | `LOAD_TEST_METRICS_INTERVAL_SECONDS` | `5` |
| `--http-timeout-ms` | `LOAD_TEST_HTTP_TIMEOUT_MS` | `10000` |
| `--outbox-drain-timeout-seconds` | `LOAD_TEST_OUTBOX_DRAIN_TIMEOUT_SECONDS` | `60` |
| `--yes` | — | não confirmado |

`--api-url` aceita várias URLs locais separadas por vírgula para balancear chamadas entre instâncias. O banco configurado em `.env` deve ser compartilhado por elas. Métricas são lidas em cada URL, com contadores comparados por instância e gauges observados sem soma.

## Métricas e método de cálculo

O runner mede latência HTTP com `performance.now()` e calcula mínimo, máximo, média e p50/p95/p99 sobre respostas realmente observadas. Percentis usam nearest-rank: ordenar as `n` amostras e selecionar a posição `ceil(p × n)`, começando na posição 1. `N/A` é usado quando não há amostra.

São reportados separadamente HTTP concluído/s, transações financeiras processadas/s, rejeições de negócio/s, replays/s, HTTP 4xx/5xx, timeout, falha de conexão, erro inesperado, taxa operacional, conflitos PostgreSQL, espera média pelo lock, tentativas e estado da outbox.

Uma rejeição de negócio como `REJECTED` por saldo insuficiente não é erro operacional. Reutilizar chave com dados divergentes é conflito esperado somente no cenário de idempotência. Um timeout permanece operacional, mesmo que uma consulta posterior encontre a transação processada.

As métricas Prometheus existentes são por processo. O runner captura leituras inicial, periódicas e final. Contadores são apresentados como delta; se um contador reiniciar entre leituras, o valor final é tratado como o trecho após o reinício. Gauges são valores observados por URL; o resumo usa o maior valor observado e não os soma. A espera de lock é um histograma agregado no processo; o relatório mostra o delta de `sum/count`, sem alegar percentis individuais de lock.

O atraso específico da execução é consultado em modo somente leitura no PostgreSQL, usando as transações das carteiras geradas. `published_at` é a confirmação usada para considerar um evento publicado, não apenas o envio ao SQS.

## Integridade financeira

Após cada ensaio, o runner compara saldo materializado e soma NUMERIC do ledger, confere regras de lançamento por tipo/estado, estados terminais, presença dos eventos correspondentes na outbox e transações aceitas pela API. Também chama a reconciliação HTTP de cada carteira. Qualquer divergência falha o benchmark e produz código de saída diferente de zero.

Se a única verificação reprovada for `outbox drenada`, o timeout terminou com eventos ainda pendentes. Isso é uma falha do limite operacional de drenagem, não uma confirmação de divergência financeira; confira a contagem de pendências no relatório. Os eventos continuam persistidos para o worker, e a execução não deve ser marcada como aprovada até a drenagem ser observada.

As consultas do runner são somente leitura. Não são executados `DELETE`, `TRUNCATE`, reset de ledger ou migrations. Carteiras, transações, ledger e outbox ficam no banco local depois da execução.

## Relatórios e segurança

Cada execução gera, sem sobrescrita:

```text
artifacts/load-tests/<execution-id>/summary.json
artifacts/load-tests/<execution-id>/report.md
```

O relatório contém a configuração, runtime e arquitetura, cenários, amostras, métricas, resultados de integridade e limitações. Não grava `.env`, senha, token nem conteúdo completo de requests. A pasta é ignorada pelo Git.

O controle web aparece no **Laboratório de Testes** quando o Vite está ativo com `bun run dev` em `web/`. O middleware local inicia o mesmo runner como subprocesso Bun e transmite o progresso para a página; erros completos ficam no terminal do Vite. Ele valida loopback e origem local e não é uma rota NestJS. O build estático não permite iniciar benchmark.

## Limitações

- O ensaio mede somente o hardware, banco, filas e processos locais da execução.
- Prometheus não agrega réplicas automaticamente; devem ser informadas URLs locais de cada instância.
- LocalStack não mede a AWS gerenciada.
- Não existe meta de RPS nem extrapolação de produção.
- Os dados financeiros do experimento são permanentes e devem ser considerados no tamanho do banco.
