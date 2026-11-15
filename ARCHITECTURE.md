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
    docs/              contrato OpenAPI e checklist da entrega

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
- **decimal.js** mantém a aritmética decimal no value object Money. A entrada e a saída usam strings de duas casas; entradas com escala maior são rejeitadas em vez de arredondadas. O banco usa NUMERIC(30,2) e o mapeamento retorna strings. number não representa valores monetários.
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

### Códigos de rejeição

Os códigos abaixo são estáveis e aparecem no `failureCode` da transação rejeitada, no resultado HTTP e no evento `WagerTransactionRejected`:

| Código | Significado | Ação esperada do provedor |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET não cabe no saldo disponível. | Corrigir a causa e, se ainda fizer sentido, enviar nova operação com nova identidade externa e chave. |
| `REVERSAL_INSUFFICIENT_FUNDS` | Uma reversão que debita a carteira faria o saldo ficar negativo. | Reconciliar e investigar; se a regra permitir nova tentativa, usar nova identidade externa e chave. |
| `INVALID_REFERENCE` | A referência foi encontrada, mas não atende tipo, escopo, moeda, rodada ou valor exigidos. | Corrigir a referência e enviar nova operação com nova identidade externa e chave. |
| `ALREADY_REVERSED` | A referência já recebeu uma reversão processada do mesmo tipo. | Não repetir a reversão. |
| `REFERENCE_EXPIRED` | A referência não chegou antes do TTL de 24 horas. | Tratar como terminal; a transação expirada não é reaberta. |

Erros que impedem a criação de uma transação financeira, como payload inválido, carteira ausente, moeda divergente ou conflito de idempotência, são respostas HTTP distintas e não são registrados como `failureCode` de uma transação inexistente.

`PROCESSING_RETRIES_EXHAUSTED` é reservado a uma entrada SQS válida que falha em todas as cinco entregas configuradas. O estado FAILED não recebe saldo de resposta, pois nenhuma movimentação financeira foi confirmada.

Transações novas começam em **PENDING**. As transições de domínio para **PENDING_REFERENCE**, **PROCESSED**, **REJECTED** e **FAILED** são modeladas e estados terminais não podem ser alterados. **OPENING** é interno e só representa uma abertura de carteira com saldo inicial positivo.

Uma mensagem SQS válida que continua falhando após cinco entregas é finalizada como **FAILED**, com `failureCode=PROCESSING_RETRIES_EXHAUSTED`. A transação, a inbox processada e a falha são gravadas na mesma transação PostgreSQL, sem atualizar carteira nem criar ledger. Em seguida, a mensagem original é enviada à DLQ. Se o próprio PostgreSQL não permitir gravar o resultado final, a mensagem segue à DLQ sem uma linha `FAILED`; esse limite é inevitável sem uma segunda fonte de persistência. Repetir a consulta ou o comando pela chave original retorna o mesmo status FAILED e código de falha. Não há evento `WagerTransactionFailed`: o enunciado não o inclui no catálogo mínimo, e a falha fica auditável pela transação persistida e pela mensagem da DLQ.

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

A entrada usa a fila **wager-transactions.fifo**, com DLQ **wager-transactions-dlq.fifo** e limite de cinco entregas, igual ao limite usado pelo consumer. Ele reutiliza o parser e o caso de uso de wagering, calcula o hash do corpo e grava a inbox na mesma transação que o resultado. Só confirma a mensagem depois do commit. Erros de negócio terminais são auditados e confirmados. Falhas operacionais recebem atraso exponencial de até 60 segundos; no quinto recebimento, o consumer grava FAILED e move a mensagem original à DLQ. Se não conseguir persistir FAILED, tenta mover a mensagem diretamente à DLQ. Mensagens inválidas vão à DLQ sem criar transação financeira. No SIGTERM, o consumer para de buscar novas mensagens e mantém a renovação da visibilidade durante o processamento; ao encerrar o handler, espera qualquer renovação em voo e interrompe o heartbeat antes de confirmar ou agendar retry.

A outbox publica na fila separada **wager-events.fifo**. Publishers concorrentes reclamam linhas elegíveis usando FOR UPDATE SKIP LOCKED, gravam lease e confirmam o claim antes de chamar SQS. Somente o menor evento ainda não publicado de cada transação é reclamado por vez. O grupo FIFO usa a transação; o ID do evento é o identificador estável de deduplicação.

Depois do envio, o publisher marca a linha publicada apenas se o lease ainda lhe pertencer. Erros incrementam tentativas e agendam retry em até 60 segundos. Se o processo cair após o envio e antes de confirmar a publicação, o lease vence e outro publisher pode enviar novamente o mesmo evento. A entrega é *at-least-once*; consumidores downstream precisam deduplicar pelo ID do evento.

## HTTP, saúde e reconciliação

- **POST /wallets** abre a carteira e, para saldo positivo, grava OPENING, crédito no ledger e eventos atomicamente. Saldo zero cria apenas a carteira.
- **POST /wagering/transactions** recebe as operações financeiras. Processado, rejeitado por regra de negócio ou FAILED recuperado por replay retorna HTTP 200 com status de domínio; referência pendente retorna HTTP 202 sem saldo; validação retorna 400; conflitos retornam 409; carteira ausente ou de outro jogador retorna 404; moeda divergente retorna 422; persistência indisponível retorna 503; falha inesperada retorna 500 sem detalhes financeiros.
- Consultas de carteira, ledger, transação e histórico são somente leitura. Ledger e transações usam cursor estável por (created_at, id), sem OFFSET. Os cursores base64url são opacos para o cliente e vinculados à carteira, mas não são assinaturas criptográficas.
- **POST /wallets/:walletId/reconciliation** compara o saldo persistido com créditos menos débitos do ledger. Informa diferença e quantidade de lançamentos; não executa reparo automático.
- **GET /health/live** verifica que o processo responde. **GET /health/ready** verifica PostgreSQL e filas SQS configuradas.

## Observabilidade

Métricas Prometheus cobrem estados de transação, duplicatas, retries, DLQ aproximada, conflitos PostgreSQL, tempo da consulta que adquire o lock por carteira, atraso da outbox e duração do processamento. Rótulos usam valores de cardinalidade controlada, sem IDs, chaves ou montantes. Métricas são locais ao processo e reiniciam com ele; um coletor deve consultar cada réplica.

Logs estruturados de controllers e workers registram eventos e identificadores operacionais disponíveis, sem payload financeiro completo. **GET /** mostra um console que combina os logs do NestJS com registros HTTP de método, rota, código e duração. **GET /activity?after=...** pagina o buffer limitado a 500 registros; ao atingir o limite, o processo descarta os mais antigos para aceitar os novos. Se o cursor do navegador ficar fora da janela retida ou a API reiniciar, a resposta sinaliza a lacuna e reposiciona o cursor no trecho mais recente para o acompanhamento continuar. A rota de consulta do console não registra a si mesma. Esse buffer é apenas diagnóstico local, não é durável nem compartilhado entre réplicas. O console não registra corpos, cabeçalhos ou parâmetros HTTP. Novos logs da aplicação devem continuar evitando segredos, payloads e valores financeiros.

## Interface de demonstração e autenticação

O painel **web/** usa Vue 3, TypeScript e Vite. **Jogo** cria ou seleciona carteira e envia comandos; **Extrato** lê o histórico paginado da API; **Laboratório de Testes** apresenta ferramentas, cenários guiados e o benchmark local. O cliente do navegador não acessa o banco nem SQS e não calcula dinheiro. Apenas o middleware de desenvolvimento pode iniciar o runner Bun separado, que chama a API e faz consultas somente leitura no PostgreSQL. Cenários criam operações persistentes que não podem ser apagadas pelo painel.

### Teste de carga

O benchmark em `test/load/` chama os endpoints HTTP existentes e valida o resultado financeiro pela reconciliação da API e por consultas PostgreSQL somente leitura. O runner reutiliza o MikroORM e as opções de conexão do backend; não cria rotas de inspeção na API financeira. O `providerId`, os jogadores, as carteiras e as chaves usam identificadores exclusivos por execução. Não há `DELETE`, `TRUNCATE` ou reset de ledger.

Os quatro cenários medem carga distribuída, disputa de saldo em uma carteira, replay/conflito de idempotência e produção/drenagem da outbox. No modo `all`, a outbox é executada antes das cargas que também produzem eventos para evitar que o seu resultado inclua um backlog criado por outro cenário. <!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:a5d696834d2477cb9a8b6d3e1bb160c3a3abb7118123cd4cf3451b980cf6be6a -->

A pressão da outbox tem limites padrão de 10 operações por carteira e 120 por ensaio, configuráveis até 1.000 e 10.000, respectivamente, para experimentos controlados.

<!-- /coderabbit-ai-generated:v1 -->

Prometheus é capturado antes, durante e depois. Contadores são comparados como deltas por URL de instância; gauges são mantidos como observações e o runner não os soma. A espera de lock reutiliza `wagering_wallet_lock_acquisition_seconds`; conflitos usam `wagering_lock_conflicts_total`; o atraso geral da outbox reutiliza `outbox_lag_seconds` e o estado específico das carteiras é consultado pela tabela `outbox_messages`.

O controle do painel é um middleware do Vite aplicado apenas ao servidor de desenvolvimento, não é registrado no NestJS e não existe no build estático. O Vite é vinculado a `127.0.0.1`; o middleware também recusa conexões não locais e valida a origem do POST. Ele permite executar somente a URL local configurada para o proxy do painel. O middleware inicia o runner como processo Bun separado usando `node:child_process`, sem depender do global `Bun` no contexto SSR do Vite; o progresso vem da saída padrão e os erros são encaminhados ao terminal do Vite. O estado temporário do job vive na memória do Vite apenas para exibir progresso; não participa de idempotência ou consistência financeira. Os relatórios duráveis são gravados em `artifacts/load-tests/<execution-id>/` e não contêm segredos.

O comando e o painel exigem confirmação porque deixam dados financeiros permanentes. API, host PostgreSQL e endpoint SQS precisam usar loopback (`localhost`, `127.0.0.1` ou `::1`); destinos remotos são recusados antes da conexão de leitura ou da criação de dados. Os padrões são locais e limitados; relatórios registram métricas não disponíveis como `N/A` em vez de estimativas. A metodologia, a fórmula de percentis e as limitações estão em `docs/LOAD_TEST_RESULTS.md` e `test/load/README.md`. Nenhum throughput de produção é inferido desse ensaio local.

O navegador guarda o identificador da carteira selecionada, o contexto da BET ativa e o último retry incerto para sobreviver a navegação e recarga. Esses dados locais não autorizam movimentações nem determinam o saldo: ao restaurar uma rodada, o painel consulta a BET e percorre o histórico paginado para verificar se já existe WIN ou LOSS terminal. Se a API indicar resultado pendente ou inconsistência, a resolução fica bloqueada e o usuário pode consultar novamente. O retry incerto preserva payload e chave originais; estado pendente é consultado pela identidade do provedor, e o estado local só é liberado depois de uma resposta terminal conhecida.

O extrato agrupa rodadas por provedor, jogo e rodada, evitando juntar identificadores iguais que pertencem a provedores diferentes. Os rótulos apresentados incluem PENDING, PENDING_REFERENCE, PROCESSED, REJECTED e FAILED.

### Decisão de autenticação

Autenticação não foi implementada: o enunciado informa que ela não vale pontos, então o timebox foi aplicado às garantias financeiras, à concorrência e à idempotência. Não há tabela local de usuários, armazenamento de senhas nem guard no-op que possa ser confundido com proteção. Nesta demonstração, **todos os endpoints HTTP estão sem autenticação**. As portas ficam vinculadas ao loopback, o que evita exposição pela rede, mas não impede acesso de outros processos da mesma máquina. Esta configuração não deve ser publicada em rede.

### Desenho pensado para autenticação

Se o serviço passar a aceitar tráfego externo, a opção que pensei seria integrar um Identity Provider OIDC externo, como Keycloak ou Zitadel, iniciado no Docker Compose. Não criar cadastro ou senha próprios. Para chamadas de provedores, usar client credentials e proteger os controllers de negócio com um NestJS `AuthGuard`/estratégia OIDC que valide assinatura via JWKS, emissor (`iss`), audiência (`aud`) e expiração do token. Os endpoints **GET /health/live** e **GET /health/ready** continuam públicos para probes de infraestrutura; as demais rotas de negócio e consultas recebem autenticação e autorização.

A identidade autenticada do token deve ser associada ao `providerId` recebido no corpo; se não corresponder, a API rejeita a chamada. Para rotas de carteira, a autorização também deve limitar quais jogadores/carteiras a identidade pode consultar ou operar. O `providerId` declarado no payload, sozinho, não autentica quem chamou.

Mensagens SQS são tratadas como entrada de um canal interno confiável e não passam pelo guard HTTP. Isso não as isenta das mesmas validações do parser, do caso de uso e do domínio: formato, identidade única, jogador e carteira, moeda, saldo, referências, idempotência e constraints do PostgreSQL. Em AWS, a permissão de envio à fila deve ser restrita por IAM aos produtores internos.

O ponto de extensão HTTP está no método `WageringController.submitWager`: ali deve ser aplicado o guard OIDC e vinculada a identidade autenticada ao `providerId` do comando. `WalletsController.create` indica o ponto equivalente para autorização de carteira. Nenhuma dessas proteções está ativa nesta entrega.

## Testes e evidências

A suíte usa Bun e serviços PostgreSQL/LocalStack reais nas integrações:

- Testes de domínio cobrem escala, arredondamento e entradas inválidas de Money; invariantes da Wallet; transições BET, WIN, LOSS, REFUND e ROLLBACK; e referências divergentes de provedor, jogador, carteira, rodada e moeda.
- Testes PostgreSQL cobrem migrations, constraints, imutabilidade, concorrência de idempotência e reversões, atomicidade, referências pendentes e reconciliação.
- O aceite HTTP executa duas BETs de 80.00 em uma carteira de 100.00 e verifica uma aprovada, uma rejeitada, saldo 20.00, um débito e reconciliação.
- Um teste mantém uma carteira bloqueada e confirma que uma operação em outra carteira conclui antes de liberar o primeiro lock.
- Um teste distribuído inicia três processos Bun, envia 50 solicitações iguais, valida um único débito e recupera referência pendente após reinício.
- Integração SQS encerra um processo real depois do commit e antes do ACK: deixa a mensagem sem confirmação, inicia uma segunda instância e verifica que a inbox evita novo débito e permite ACK na redelivery.
- Integração da outbox encerra o publisher depois que o LocalStack aceita o evento, mas antes de o processo confirmar a publicação no PostgreSQL. O lease é expirado deterministicamente no teste; outra instância recupera os registros e o evento não se perde.
- Integração SQS induz falha operacional até a quinta entrega, confirma transação FAILED e inbox concluída, ausência de lançamento e saldo inalterado, consulta por replay idempotente e envio da mensagem original à DLQ.
- Integração PostgreSQL encerra a conexão do backend antes do commit e confirma que saldo, transação, ledger e outbox não ficam parcialmente gravados; a mesma solicitação pode ser repetida depois.
- Integração com duas instâncias reais disputa saldo, valida um único débito, reinicia o serviço e confirma replay idempotente e conflito para payload divergente.
- A integração SQS também exercita retry transitório e DLQ.

O contrato em **docs/openapi.yaml** documenta as rotas HTTP implementadas. A interface possui testes das regras de apresentação, persistência local de contexto e contratos do cliente HTTP; os testes financeiros e de integração permanecem no backend, onde as regras são autoritativas.

Os cenários de concorrência são testes de correção, não ensaios de carga. Não há afirmação de throughput, p95/p99 ou capacidade de produção.
