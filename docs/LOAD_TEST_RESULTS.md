# Teste de carga e leitura de resultados

## Situação dos resultados

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:9047f2c0396e1fb6186e538ac19ac1f6497a1367b3ab20e4e1af7352caf68a7a -->

### Execução local de 15/11/2026

A execução `411adbb4-554d-46bf-af65-9943fbb4e448` ocorreu entre 02:12:49 e 02:19:25 UTC, com integridade aprovada nos 36 ensaios. O relatório bruto permanece em `artifacts/load-tests/`, fora do Git. O código do runner era o da alteração em andamento, anterior à adição do contador de núcleos físicos; essa contagem foi conferida separadamente com `lscpu` no mesmo ambiente.

**Ambiente:** Linux x64, Intel Xeon 2,90 GHz, 4 CPUs lógicas e 2 núcleos físicos visíveis; memória total visível 8,21 GiB (limite do cgroup: 8 GiB); Bun 1.4.2, PostgreSQL 17.12, LocalStack 4.14.0, Docker servidor 29.1.3. Uma instância da API, um consumer e um publisher, declarados pelo operador. PostgreSQL e LocalStack executaram em containers locais. O healthcheck do Compose para LocalStack excedeu o timeout de 3 s; a prontidão HTTP da API e as filas SQS responderam no mesmo ambiente.

**Configuração:** cenário `all`, teto de 60 s, aquecimento de 10 s, 3 repetições e concorrências 10, 25 e 50; 12 carteiras, 100 operações por carteira para distributed, outbox limitada a 10 por carteira e 120 por ensaio. A execução foi feita com o comando de evidência de `test/load/README.md`. Os cenários outbox e distributed atingiram seus limites: a carga medida durou aproximadamente 0,18–0,36 s e 1,36–2,52 s, respectivamente. Contention e idempotency são rajadas fixas. Assim, os 60 s não representam carga sustentada nem determinam o ponto de saturação.

A tabela traz a **mediana dos três resultados de cada ensaio** para throughput, percentis HTTP e espera média de lock; não são percentis calculados sobre amostras agrupadas. A taxa de erro é o maior valor entre as repetições. Conflitos são somados nas três repetições; o atraso e a drenagem são os máximos observados. Drenagem só é medida no cenário outbox; N/A significa não medida.

| Cenário | Concorrência | HTTP/s | Financeiras/s | p50 ms | p95 ms | p99 ms | Erro operacional máx. % | Conflitos idempotência | Conflitos lock | Espera média lock ms | Outbox lag máx. s | Drenagem máx. ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| outbox | 10 | 442.82 | 442.82 | 21.00 | 31.49 | 36.46 | 0.00 | 0 | 0 | 1.40 | 1.56 | 2009.00 |
| outbox | 25 | 572.36 | 572.36 | 39.18 | 54.01 | 59.16 | 0.00 | 0 | 0 | 1.35 | 1.17 | 1514.00 |
| outbox | 50 | 606.34 | 606.34 | 70.63 | 94.60 | 100.52 | 0.00 | 0 | 0 | 1.44 | 1.04 | 1515.00 |
| distributed | 10 | 581.21 | 581.21 | 16.43 | 26.14 | 32.00 | 0.00 | 0 | 0 | 1.18 | 10.03 | N/A |
| distributed | 25 | 573.22 | 573.22 | 41.52 | 64.30 | 87.20 | 0.00 | 0 | 0 | 1.45 | 2.31 | N/A |
| distributed | 50 | 853.35 | 853.35 | 57.33 | 71.06 | 90.74 | 0.00 | 0 | 0 | 0.84 | 12.27 | N/A |
| contention | 10 | 268.13 | 26.81 | 22.55 | 34.87 | 34.87 | 0.00 | 0 | 0 | 15.43 | 0.05 | N/A |
| contention | 25 | 387.98 | 15.52 | 36.98 | 60.36 | 62.55 | 0.00 | 0 | 0 | 17.06 | 0.06 | N/A |
| contention | 50 | 388.54 | 7.77 | 68.37 | 120.29 | 126.25 | 0.00 | 0 | 0 | 18.75 | 0.13 | N/A |
| idempotency | 10 | 1120.79 | 56.04 | 3.74 | 12.09 | 12.69 | 0.00 | 30 | 0 | 5.90 | 0.02 | N/A |
| idempotency | 25 | 1634.73 | 32.69 | 10.33 | 17.39 | 18.60 | 0.00 | 75 | 0 | 7.35 | 0.03 | N/A |
| idempotency | 50 | 2327.19 | 23.27 | 15.07 | 23.76 | 24.43 | 0.00 | 150 | 0 | 7.77 | 0.05 | N/A |

Os conflitos de idempotência acima foram esperados no cenário de payload divergente. As verificações de saldo, ledger, estados, eventos e reconciliação passaram em todos os ensaios; nos nove ensaios da outbox também foi observada a drenagem. O lag é a maior idade amostrada de eventos pendentes das carteiras do ensaio, incluindo eventos criados antes da carga medida. Essas medições descrevem somente esta execução local, não capacidade de produção.


<!-- /coderabbit-ai-generated:v1 -->

## Preparar o ambiente

Use apenas a execução local documentada no README. PostgreSQL, LocalStack, API e workers devem estar ativos, e `GET /health/ready` deve indicar que a API e as dependências estão prontas. O runner recusa URLs não locais. A tela do Laboratório apresenta o controle somente quando o painel é executado pelo servidor Vite de desenvolvimento.

Ao iniciar pela tela, o middleware local chama o runner Bun em um processo separado e atualiza o andamento a partir da saída do processo. O `Bun` precisa estar acessível pelo runtime atual do Vite ou pelo `PATH`. A tela não chama uma rota administrativa da API. O runner continua pedindo confirmação antes de criar dados financeiros permanentes.

## Executar pela linha de comando

```powershell
bun run test:load
```

O comando pede confirmação porque cria carteiras, transações e eventos permanentes. Um exemplo de investigação com parâmetros explícitos:

```powershell
bun run test:load -- --yes --scenario contention --duration-seconds 10 --warmup-seconds 2 --repetitions 1 --concurrency 10,25,50
```

Consulte `test/load/README.md` para todas as variáveis e opções. O cenário `all` é o padrão; é possível selecionar `distributed`, `contention`, `idempotency` ou `outbox`.

## Interpretar as medições

- **p50/p95/p99:** percentis nearest-rank calculados com as latências HTTP observadas; não são estimativas ou valores de buckets Prometheus.
- **HTTP/s:** respostas HTTP recebidas divididas pelo tempo real medido, incluindo respostas de erro.
- **Operações financeiras/s:** transações `PROCESSED` não classificadas como replay idempotente.
- **Rejeição de negócio:** transações `REJECTED`, apresentadas separadas da taxa de erro operacional.
- **Replay:** resposta idempotente da API; não conta como nova movimentação financeira.
- **Conflito de idempotência:** HTTP 409 esperado apenas no caso de payload divergente do cenário correspondente.
- **Conflito de lock:** contador existente de deadlock, serialização ou lock indisponível. Espera de lock normal não é conflito.
- **Espera pelo lock:** média do delta `sum/count` do histograma da aplicação; é agregada por processo.
- **Atraso da outbox:** gauge Prometheus por processo e idade do evento pendente mais antigo das carteiras do ensaio, consultada no PostgreSQL.
- **Drenagem:** tempo entre o fim da produção e a observação de zero eventos pendentes para as carteiras testadas.

Contadores Prometheus são subtraídos entre a amostra inicial e a final de cada instância. Após reinício, o valor final representa o contador observado depois do reinício. Gauges não são tratados como contadores nem somados entre processos. A coleta periódica permanece no JSON para permitir auditoria das variações.

## Integridade e falhas

O runner verifica saldo materializado contra a soma decimal do ledger, regras de lançamento, estados terminais, eventos correspondentes na outbox, persistência de operações aceitas e reconciliação pela API. `published_at` é a evidência de publicação confirmada no PostgreSQL. Uma divergência financeira faz o comando retornar código diferente de zero e aparece no relatório como falha, separada dos números de desempenho.

A verificação `outbox drenada` é um limite operacional separado: se ainda há eventos pendentes ao fim do timeout, o resultado geral de integridade fica como **FALHOU**, mesmo que saldo, ledger, transações e correspondência dos eventos estejam aprovados. Isso indica que a outbox não alcançou zero pendências no prazo; não significa, por si só, divergência financeira ou perda de eventos. O relatório deve ser conferido para saber qual verificação falhou e quantos eventos restaram. <!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:33bd5df7978edfaf0167fc6281022b2c290ca47f91622e4768448d680a202905 -->

No modo `all`, esse cenário é executado antes dos demais, com limites padrão de 10 operações por carteira e 120 por ensaio, para que sua drenagem não seja contaminada por eventos produzidos pelos cenários distribuídos. Esses limites podem ser ampliados dentro dos tetos documentados no guia do benchmark.

<!-- /coderabbit-ai-generated:v1 -->

Não se deve classificar uma execução como aprovada sem confirmar a drenagem.

Uma rejeição de saldo insuficiente não é erro operacional. Timeouts, falhas de conexão, HTTP 5xx e 4xx inesperados são contabilizados como problemas operacionais. Se uma resposta expirar, o registro persistido ainda é conferido para identificar um commit cuja resposta não chegou ao cliente.

## Limites e reprodução

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:e58461326594d9e4b05f3bd54a6a92d2053fb26167de62d83f0a09c317cd4765 -->

Os relatórios incluem configuração, versão do Bun, sistema, arquitetura, <!-- coderabbit-ai-generated:v1 --> <!-- coderabbit-ai-generated-section:v1:9e67e5f6901eb9ff0a88ab0f5eb7526692f9c5fc5b9198a2a9c889d12c54b734 --> modelo da CPU, quantidade de CPUs lógicas e de núcleos físicos visíveis quando disponível, memória total visível ao host <!-- /coderabbit-ai-generated:v1 -->, versões detectadas de PostgreSQL, LocalStack e Docker, horários, amostras e verificações. Contagens de processos são fornecidas pelo operador e o que não puder ser identificado aparece como N/A; limites de recursos de contêiner podem diferir dos valores do host.

<!-- /coderabbit-ai-generated:v1 -->

Eles não guardam segredos. Os registros da execução permanecem no banco: o benchmark não remove carteiras, ledger ou eventos.

Os números dependem de CPU, Docker, PostgreSQL, LocalStack, quantidade de instâncias, configuração dos workers e estado do host. Não representam capacidade garantida em produção e não têm alvo de RPS. Para comparar execuções, mantenha as mesmas configurações, número de processos, estado das dependências e recursos de hardware; registre diferenças no relatório de análise sem alterar os dados medidos.
