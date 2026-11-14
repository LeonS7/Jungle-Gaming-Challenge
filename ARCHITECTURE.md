# Arquitetura e decisões técnicas

## Objetivo e limites

O serviço processa operações de apostas com entrega *at-least-once*, múltiplas instâncias e dependências que podem ficar indisponíveis. PostgreSQL é a fonte de verdade para saldo, idempotência, inbox e outbox. SQS transporta solicitações e eventos, mas não substitui as garantias do banco.

A interface web é um cliente de demonstração conectado à API real. Ela não calcula saldos nem aplica regras de negócio. A raiz da API serve um console de atividade local para facilitar testes manuais.

## Organização do repositório

    src/
      domain/          dinheiro, carteira, transação, ledger, inbox e outbox
      application/     casos de uso, eventos, portas e contratos
      infrastructure/ PostgreSQL, migrations, SQS, workers e observabilidade
      presentation/   controllers HTTP, DTOs e validação
      config/          configuração validada
      app.module.ts    composição das dependências NestJS
      main.ts          inicialização do processo
    test/
      unit/            regras isoladas
      integration/     banco, SQS, HTTP, concorrência e recuperação
    web/
      src/api/         chamadas HTTP do painel
      src/features/    jogo, extrato, carteiras e laboratório
      test/            contratos e regras de apresentação
    docker/            criação das filas locais do LocalStack
    docs/              parte documentada do contrato OpenAPI

As pastas seguem as fronteiras Domain, Application, Infrastructure e Presentation sem camadas adicionais para cada conceito. Registros do MikroORM ficam separados das entidades de domínio. Migrations versionadas ficam em **src/infrastructure/persistence/migrations** e não são aplicadas automaticamente ao iniciar a API.

## Fluxo de processamento

1. O controller HTTP ou o consumer SQS valida a entrada e chama `ProcessWager`.
2. O fluxo HTTP usa `Idempotency-Key`; o fluxo SQS também grava a identidade da mensagem na inbox.
3. Uma transação PostgreSQL serializa as operações da carteira e grava transação, saldo, ledger e outbox; para SQS, grava a inbox na mesma transação.
4. Depois do commit, o consumer pode confirmar a mensagem recebida. Um publisher separado envia à SQS somente eventos já persistidos na outbox.
5. Workers consultam o PostgreSQL para publicar outbox pendente e resolver referências fora de ordem.

Para HTTP, a chave de idempotência e os efeitos financeiros são transacionais, sem registro de inbox. Para SQS, a inbox é gravada na mesma transação dos efeitos financeiros. O consumer exclui a mensagem de entrada somente depois do retorno após o commit. O publisher consulta apenas linhas de outbox já confirmadas no PostgreSQL.

## Decisões de tecnologia e dinheiro

- **Bun 1.x** instala, executa e testa os pacotes; **TypeScript strict** verifica os tipos; **NestJS** entrega a API.
- **MikroORM** mapeia o PostgreSQL. SQL explícito é usado nos trechos que precisam demonstrar locks, constraints, claims e precisão dos cursores.
- **decimal.js** mantém a aritmética decimal no value object Money. A entrada e a saída usam strings de duas casas; o banco usa NUMERIC(30,2) e o mapeamento retorna strings. number não representa valores monetários.
- O domínio valida moedas e impede operações entre moedas diferentes. Os exemplos de demonstração usam BRL.
- IDs são UUIDs, as datas usam TIMESTAMPTZ, e o ledger registra valor, direção, saldo anterior e saldo posterior.
- PostgreSQL e LocalStack SQS são iniciados por Docker Compose. LocalStack é o alvo local de desenvolvimento e testes; provisionamento e operação em AWS de produção não fazem parte do escopo entregue.

## Regras do domínio

| Operação | Efeito financeiro | Regra de referência |
|---|---|---|
| BET | Débito | Rejeita saldo insuficiente. |
| WIN | Crédito | A referência à BET da mesma rodada é opcional; uma referência inválida é rejeitada. |
| LOSS | Nenhum | Registra resultado e snapshot do saldo, sem alterar versão, saldo ou ledger. |
| REFUND | Crédito | Exige BET processada correspondente; aplica valor integral. |
| ROLLBACK | Inverso da operação referenciada | Aceita BET, WIN ou REFUND processada; aplica valor integral. |

As referências de reversão devem corresponder a provedor, jogador, carteira, rodada, valor e moeda. Uma transação com referência ausente ou ainda não finalizada fica em **PENDING_REFERENCE**, sem efeito financeiro. Referência que viola uma regra conhecida é rejeitada, não fica pendente.

Transações novas começam em **PENDING**. Podem avançar para **PENDING_REFERENCE**, **PROCESSED**, **REJECTED** ou **FAILED** conforme as regras. Estados terminais não podem ser alterados. **OPENING** é interno e só representa uma abertura de carteira com saldo inicial positivo.

## Integridade e concorrência no PostgreSQL

As migrations são parte das regras do sistema, não apenas estrutura de armazenamento:

- Carteira única por (player_id, currency), saldo não negativo, versão inicial igual a 1 e trigger para impedir alteração da identidade e exigir avanço de versão quando o saldo muda.
- Transação com chave de idempotência global única e unicidade de (provider_id, external_transaction_id).
- Constraints validam campos, valores positivos, combinações de estado e referências compostas. Transições de estado e campos originais da transação são protegidos no banco.
- Índice único parcial permite no máximo uma reversão processada por (reference_transaction_id, kind).
- Ledger único por (wallet_id, transaction_id), com constraint aritmética e moeda compatível. Triggers bloqueiam UPDATE, DELETE e TRUNCATE; outro trigger impede lançamentos para LOSS, REJECTED e FAILED.
- Inbox única por (consumer_name, message_id). A identidade, o hash e o horário de recebimento não podem ser alterados; processamento só pode avançar uma vez.
- Outbox vincula evento à transação, valida o envelope e mantém sequência única. Conteúdo e remoção são protegidos; tentativas, lease e confirmação de publicação podem avançar conforme o ciclo do publisher.

### Unidade de concorrência

Cada operação adquire SELECT ... FOR UPDATE apenas sobre sua carteira. Isso ordena os movimentos financeiros da mesma carteira e permite progresso simultâneo entre carteiras diferentes. A aplicação cria o ledger com os saldos observados e atualiza a carteira sob o mesmo lock e transação PostgreSQL. Constraints continuam sendo a última barreira caso outro caminho de escrita seja introduzido.

O fluxo consulta primeiro a chave de idempotência, bloqueia a carteira e consulta a chave novamente antes de efetuar efeitos. Se várias instâncias disputarem a mesma chave global, a constraint única arbitra a corrida; após o rollback de quem perdeu, o caso de uso recupera e compara o resultado persistido. A correção não depende de estado local nem da deduplicação FIFO.

### Atomicidade financeira

A transação PostgreSQL grava as linhas financeiras, atualiza o saldo quando necessário, registra o lançamento, salva o snapshot de resposta e insere os eventos correspondentes na outbox. Em entrada SQS, a mesma transação grava e conclui a inbox. Falha antes do commit reverte o conjunto; publicação SQS ocorre em outro processo depois do commit.

Rejeições de negócio ficam auditáveis com failureCode, mas não alteram saldo nem criam ledger. LOSS é processada e gera evento de resultado, porém não gera evento de saldo. A repetição idempotente responde com o snapshot histórico da operação original.

## Idempotência, identidade e reversões

Idempotency-Key é obrigatória em HTTP. A chave é global no banco. O serviço calcula SHA-256 de JSON canônico com os campos de negócio em ordem fixa: externalTransactionId, gameId, kind, money (amount e currency), playerId, providerId, referenceExternalTransactionId quando informado, roundId e walletId. A quantia é normalizada antes do hash. A chave de idempotência e os metadados de transporte ficam fora do hash.

Chave e hash iguais devolvem o resultado persistido com idempotentReplay: true. Chave igual e hash diferente gera conflito HTTP 409. (provider_id, external_transaction_id) também é único, impedindo que uma identidade externa seja associada a resultados distintos.

O índice parcial do PostgreSQL e a validação no domínio impedem repetir a mesma reversão processada. REFUND e ROLLBACK são tipos diferentes e podem cada um referenciar a mesma transação, conforme o contrato do desafio. O rollback que levaria a carteira abaixo de zero recebe rejeição própria, sem lançamento.

## Referências pendentes e recuperação

PendingReferenceWorker seleciona operações vencidas com FOR UPDATE SKIP LOCKED, permitindo execução em múltiplas instâncias. A consulta da referência, eventual mudança financeira, conclusão da transação e novos eventos ocorrem no mesmo commit.

A política usa atraso inicial de 1 segundo, dobra a cada tentativa até 300 segundos e prazo total de 24 horas. O próximo retry não ultrapassa a expiração. Ao expirar, a transação termina como REJECTED/REFERENCE_EXPIRED e gera o evento final. Uma transação expirada não é reaberta se a referência chegar depois.

A inbox conserva a chave (consumer_name, message_id) sem política de expurgo. Remover registros antigos reduziria a janela de deduplicação. Após o commit financeiro, uma mensagem que reapareça é reconhecida como duplicata pela inbox e pode receber ACK sem repetir o efeito.

## Outbox e SQS

A entrada usa a fila **wager-transactions.fifo**, com DLQ **wager-transactions-dlq.fifo**. O consumidor reutiliza o parser e o caso de uso de wagering, calcula o hash do corpo, grava a inbox e só confirma a mensagem após o commit. Erros de negócio terminais são auditados e confirmados. Falhas operacionais recebem nova tentativa com atraso exponencial até 60 segundos; mensagens inválidas vão à DLQ antes da remoção da origem. A fila local move mensagens após cinco recebimentos.

A outbox publica na fila separada **wager-events.fifo**. Publishers concorrentes reclamam linhas elegíveis usando FOR UPDATE SKIP LOCKED, gravam lease e confirmam o claim antes de chamar SQS. Somente o menor evento ainda não publicado de cada transação é reclamado por vez. O grupo FIFO usa a transação; o ID do evento é o identificador estável de deduplicação.

Depois do envio, o publisher marca a linha publicada apenas se o lease ainda lhe pertencer. Erros incrementam tentativas e agendam retry em até 60 segundos. Se o processo cair após o envio e antes de confirmar a publicação, o lease vence e outro publisher pode enviar novamente o mesmo evento. A entrega é *at-least-once*; consumidores downstream precisam deduplicar pelo ID do evento.

## HTTP, saúde e reconciliação

- **POST /wallets** abre a carteira e, para saldo positivo, grava OPENING, crédito no ledger e eventos atomicamente. Saldo zero cria apenas a carteira.
- **POST /wagering/transactions** recebe as operações financeiras. Processado ou rejeitado por regra de negócio retorna HTTP 200 com status de domínio; referência pendente retorna HTTP 202 sem saldo; validação retorna 400; conflitos retornam 409; carteira ausente ou de outro jogador retorna 404; moeda divergente retorna 422; persistência indisponível retorna 503; falha inesperada retorna 500 sem detalhes financeiros.
- Consultas de carteira, ledger, transação e histórico são somente leitura. Ledger e transações usam cursor estável por (created_at, id), sem OFFSET. Os cursores base64url são opacos para o cliente e vinculados à carteira, mas não são assinaturas criptográficas.
- **POST /wallets/:walletId/reconciliation** compara o saldo persistido com créditos menos débitos do ledger. Informa diferença e quantidade de lançamentos; não executa reparo automático.
- **GET /health/live** verifica que o processo responde. **GET /health/ready** verifica PostgreSQL e filas SQS configuradas.

## Observabilidade

Métricas Prometheus cobrem estados de transação, duplicatas, retries, DLQ aproximada, conflitos PostgreSQL, tempo da consulta que adquire o lock por carteira, atraso da outbox e duração do processamento. Rótulos usam valores de cardinalidade controlada, sem IDs, chaves ou montantes. Métricas são locais ao processo e reiniciam com ele; um coletor deve consultar cada réplica.

Logs estruturados de controllers e workers registram eventos e identificadores operacionais disponíveis, sem payload financeiro completo. **GET /** mostra um console que combina os logs do NestJS com registros HTTP de método, rota, código e duração. **GET /activity?after=...** pagina o buffer limitado a 500 registros. A rota de consulta do console não registra a si mesma. Esse buffer é apenas diagnóstico local, não é durável nem compartilhado entre réplicas. O console não registra corpos, cabeçalhos ou parâmetros HTTP. Novos logs da aplicação devem continuar evitando segredos, payloads e valores financeiros.

## Interface de demonstração e autenticação

O painel **web/** usa Vue 3, TypeScript e Vite. **Jogo** cria ou seleciona carteira e envia comandos; **Extrato** lê o histórico paginado da API; **Laboratório de Testes** apresenta ferramentas e cenários guiados. O painel não acessa o banco ou SQS e não calcula dinheiro. Cenários criam operações persistentes que não podem ser apagadas pelo painel.

Autenticação não foi implementada porque o enunciado permite deixá-la fora do timebox e ela não pontua. Não há usuários locais nem senha artesanal. A API e as portas dos serviços ficam no loopback para demonstração, mas outros processos da máquina ainda podem acessá-las. Não se deve publicar essa configuração em rede. Para implantação, integrar um provedor de identidade externo e acrescentar guard e autorização aos endpoints; o comentário em WageringController marca o ponto de extensão para essa integração.

## Testes e evidências

A suíte usa Bun e serviços PostgreSQL/LocalStack reais nas integrações:

- Testes de domínio cobrem operações decimais, carteiras, transições, ledger, reversões e referências.
- Testes PostgreSQL cobrem migrations, constraints, imutabilidade, concorrência de idempotência e reversões, atomicidade, referências pendentes e reconciliação.
- O aceite HTTP executa duas BETs de 80.00 em uma carteira de 100.00 e verifica uma aprovada, uma rejeitada, saldo 20.00, um débito e reconciliação.
- Um teste mantém uma carteira bloqueada e confirma que uma operação em outra carteira conclui antes de liberar o primeiro lock.
- Um teste distribuído inicia três processos Bun, envia 50 solicitações iguais, valida um único débito e recupera referência pendente após reinício.
- Integração SQS simula o intervalo após o commit e antes do ACK: confirma os efeitos financeiros, deixa a mensagem sem confirmação, a torna visível novamente e inicia o consumer real. A inbox identifica duplicata e a redelivery recebe ACK sem novo débito. O mesmo teste exercita retry transitório e DLQ.

Os cenários de concorrência são testes de correção, não ensaios de carga. Não há afirmação de throughput, p95/p99 ou capacidade de produção.
