# Teste de carga e leitura de resultados

## Situação dos resultados

Este documento descreve como executar e interpretar o benchmark. Ele não registra números medidos nesta alteração: nenhum resultado de throughput, latência ou capacidade é presumido. Cada execução real gera o próprio relatório em `artifacts/load-tests/<execution-id>/`.

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

A verificação `outbox drenada` é um limite operacional separado: se ainda há eventos pendentes ao fim do timeout, o resultado geral de integridade fica como **FALHOU**, mesmo que saldo, ledger, transações e correspondência dos eventos estejam aprovados. Isso indica que a outbox não alcançou zero pendências no prazo; não significa, por si só, divergência financeira ou perda de eventos. O relatório deve ser conferido para saber qual verificação falhou e quantos eventos restaram. No modo `all`, esse cenário é executado antes dos demais e limitado a 10 operações por carteira e 120 por execução, para que sua drenagem não seja contaminada por eventos produzidos pelos cenários distribuídos. Não se deve classificar uma execução como aprovada sem confirmar a drenagem.

Uma rejeição de saldo insuficiente não é erro operacional. Timeouts, falhas de conexão, HTTP 5xx e 4xx inesperados são contabilizados como problemas operacionais. Se uma resposta expirar, o registro persistido ainda é conferido para identificar um commit cuja resposta não chegou ao cliente.

## Limites e reprodução

Os relatórios incluem a configuração, versão Bun, sistema operacional, arquitetura, número de CPUs, horários, amostras e verificações. Eles não guardam segredos. Os registros da execução permanecem no banco: o benchmark não remove carteiras, ledger ou eventos.

Os números dependem de CPU, Docker, PostgreSQL, LocalStack, quantidade de instâncias, configuração dos workers e estado do host. Não representam capacidade garantida em produção e não têm alvo de RPS. Para comparar execuções, mantenha as mesmas configurações, número de processos, estado das dependências e recursos de hardware; registre diferenças no relatório de análise sem alterar os dados medidos.
