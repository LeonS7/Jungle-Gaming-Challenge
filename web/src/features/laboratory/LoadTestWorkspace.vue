<!-- Esta página controla o benchmark local e apresenta medições e relatórios reais. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import {
  LoadTestApiError,
  readLoadTestAvailability,
  readLoadTestProgress,
  startLoadTest,
  type LoadTestAvailability,
  type LoadTestFormValues,
  type LoadTestProgress,
} from '../../api/load-test-api';

const STORAGE_KEY = 'jungle-wagering.load-test.execution';

const availability = ref<LoadTestAvailability | null>(null);
const progress = ref<LoadTestProgress | null>(null);
const errorMessage = ref<string | null>(null);
const loading = ref(false);
const refreshing = ref(false);
const concurrencyInput = ref('10');
const form = reactive({
  scenario: 'distributed' as LoadTestFormValues['scenario'],
  durationSeconds: 10,
  warmupSeconds: 1,
  repetitions: 1,
  walletCount: 12,
  operationsPerWallet: 100,
  metricsIntervalSeconds: 5,
  httpTimeoutMilliseconds: 10_000,
  outboxDrainTimeoutSeconds: 60,
});
let pollingTimer: ReturnType<typeof setInterval> | undefined;

const active = computed(() => progress.value?.state === 'starting' || progress.value?.state === 'running');
const finalResults = computed(() => progress.value?.report?.results ?? []);

function stateLabel(state: LoadTestProgress['state'] | undefined): string {
  if (state === 'completed') return 'Concluído';
  if (state === 'failed') return 'Falhou';
  if (state === 'running') return 'Em execução';
  if (state === 'starting') return 'Preparando';
  return 'Aguardando';
}

function scenarioLabel(scenario: string): string {
  const labels: Readonly<Record<string, string>> = {
    distributed: 'Carteiras distribuídas',
    contention: 'Concorrência na mesma carteira',
    idempotency: 'Idempotência sob carga',
    outbox: 'Pressão e drenagem da outbox',
  };
  return labels[scenario] ?? scenario;
}

function decimal(value: number | null, digits = 2): string {
  return value === null || !Number.isFinite(value)
    ? 'N/A'
    : value.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function validateForm(): LoadTestFormValues {
  const concurrencyLevels = concurrencyInput.value.split(',').map((value) => Number(value.trim()));
  if (
    concurrencyLevels.length === 0 ||
    concurrencyLevels.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 200)
  ) {
    throw new Error('Informe concorrências inteiras entre 1 e 200, separadas por vírgula.');
  }
  return {
    ...form,
    concurrencyLevels: [...new Set(concurrencyLevels)],
  };
}

function stopPolling(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = undefined;
  }
}

async function refreshProgress(): Promise<void> {
  const executionId = progress.value?.executionId;
  if (!executionId || refreshing.value) return;
  refreshing.value = true;
  try {
    const latest = await readLoadTestProgress(executionId);
    progress.value = latest;
    if (latest.state === 'completed' || latest.state === 'failed') {
      stopPolling();
    }
  } catch (error) {
    if (error instanceof LoadTestApiError && error.status === 404) {
      errorMessage.value = 'O processo Vite foi reiniciado. Os relatórios já gravados continuam na pasta artifacts/load-tests.';
      stopPolling();
    } else {
      errorMessage.value = error instanceof Error ? error.message : 'Não foi possível consultar o andamento.';
    }
  } finally {
    refreshing.value = false;
  }
}

function startPolling(): void {
  stopPolling();
  pollingTimer = setInterval(() => void refreshProgress(), 1000);
}

async function startBenchmark(): Promise<void> {
  errorMessage.value = null;
  let values: LoadTestFormValues;
  try {
    values = validateForm();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Revise os parâmetros do benchmark.';
    return;
  }
  const confirmed = window.confirm(
    'O benchmark criará carteiras, transações, lançamentos de ledger e eventos permanentes no PostgreSQL local. Esses registros não serão apagados. Deseja iniciar?',
  );
  if (!confirmed) return;

  loading.value = true;
  try {
    const started = await startLoadTest(values);
    progress.value = started;
    window.localStorage.setItem(STORAGE_KEY, started.executionId);
    startPolling();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Não foi possível iniciar o benchmark.';
  } finally {
    loading.value = false;
  }
}

async function refreshAvailability(): Promise<void> {
  try {
    availability.value = await readLoadTestAvailability();
  } catch {
    availability.value = {
      available: false,
      mode: 'indisponível',
      message: 'O controle do benchmark só existe no servidor Vite de desenvolvimento local.',
    };
  }
}

onMounted(async () => {
  await refreshAvailability();
  try {
    const previousExecutionId = window.localStorage.getItem(STORAGE_KEY);
    if (previousExecutionId) {
      try {
        progress.value = await readLoadTestProgress(previousExecutionId);
        if (active.value) startPolling();
      } catch {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    }
  } catch {
    availability.value = {
      available: false,
      mode: 'indisponível',
      message: 'O controle do benchmark só existe no servidor Vite de desenvolvimento local.',
    };
  }
});

onUnmounted(stopPolling);
</script>

<template>
  <section class="load-test-card" aria-labelledby="load-test-title">
    <div class="load-test-heading">
      <div>
        <p class="load-test-kicker">BENCHMARK LOCAL · API E POSTGRESQL REAIS</p>
        <h2 id="load-test-title">Teste de carga</h2>
        <p class="load-test-description">
          Mede a API, concorrência financeira, idempotência e drenagem da outbox. Nenhum saldo é calculado no navegador.
        </p>
        <p class="load-test-description">
          Em “Todos os cenários”, a outbox roda primeiro e usa até 10 operações por carteira, com máximo de 120 operações, para medir drenagem sem backlog dos outros cenários.
        </p>
      </div>
      <span class="load-test-state" :class="active ? 'load-test-state-active' : ''">
        <span aria-hidden="true"></span>{{ stateLabel(progress?.state) }}
      </span>
    </div>

    <div v-if="!availability?.available" class="load-test-notice" role="status">
      <strong>Controle local indisponível</strong>
      <span>{{ availability?.message || 'Verificando o servidor local de desenvolvimento…' }}</span>
      <span>O controle não é incluído em builds de produção e aceita somente API em loopback.</span>
      <button class="load-test-refresh" type="button" @click="refreshAvailability">Verificar novamente</button>
    </div>

    <template v-else>
      <div class="load-test-persistent-warning" role="note">
        <strong>Os registros do benchmark são permanentes.</strong>
        Cada execução cria carteiras, transações, ledger e eventos. Não há limpeza automática nem reset financeiro.
      </div>

      <form class="load-test-form" @submit.prevent="startBenchmark">
        <label>
          Cenário
          <select v-model="form.scenario" :disabled="active">
            <option value="all">Todos os cenários</option>
            <option value="distributed">Carteiras distribuídas</option>
            <option value="contention">Concorrência na mesma carteira</option>
            <option value="idempotency">Idempotência sob carga</option>
            <option value="outbox">Pressão e drenagem da outbox</option>
          </select>
        </label>
        <label>
          Duração máxima (segundos)
          <input v-model.number="form.durationSeconds" type="number" min="1" max="3600" :disabled="active">
        </label>
        <label>
          Aquecimento (segundos)
          <input v-model.number="form.warmupSeconds" type="number" min="0" max="300" :disabled="active">
        </label>
        <label>
          Repetições
          <input v-model.number="form.repetitions" type="number" min="1" max="10" :disabled="active">
        </label>
        <label>
          Concorrências
          <input v-model="concurrencyInput" type="text" inputmode="numeric" aria-describedby="load-test-concurrency-help" :disabled="active">
          <small id="load-test-concurrency-help">Inteiros entre 1 e 200, separados por vírgula.</small>
        </label>
        <label>
          Carteiras distribuídas
          <input v-model.number="form.walletCount" type="number" min="1" max="250" :disabled="active">
        </label>
        <label>
          Operações máximas por carteira
          <input v-model.number="form.operationsPerWallet" type="number" min="1" max="100000" :disabled="active">
          <small>Aplica-se ao cenário distribuído. A outbox usa seu limite próprio de demonstração.</small>
        </label>
        <label>
          Intervalo de métricas (segundos)
          <input v-model.number="form.metricsIntervalSeconds" type="number" min="1" max="3600" :disabled="active">
        </label>
        <label>
          Timeout HTTP (ms)
          <input v-model.number="form.httpTimeoutMilliseconds" type="number" min="100" max="120000" :disabled="active">
        </label>
        <label>
          Limite para drenagem (segundos)
          <input v-model.number="form.outboxDrainTimeoutSeconds" type="number" min="1" max="3600" :disabled="active">
        </label>
        <div class="load-test-actions">
          <button class="load-test-start" type="submit" :disabled="loading || active">
            {{ loading ? 'Iniciando…' : active ? 'Benchmark em andamento' : 'Executar benchmark' }}
          </button>
          <span>Somente o cenário selecionado e as opções informadas serão executados.</span>
        </div>
      </form>

      <p v-if="errorMessage" class="load-test-error" role="alert">{{ errorMessage }}</p>

      <section v-if="progress" class="load-test-progress" aria-live="polite">
        <div class="load-test-progress-title">
          <div>
            <span>Execução {{ progress.executionId }}</span>
            <strong>{{ progress.message }}</strong>
          </div>
          <span v-if="progress.completedRequests !== undefined">{{ progress.completedRequests.toLocaleString('pt-BR') }} respostas medidas</span>
        </div>
        <div v-if="progress.report" class="load-test-report-links">
          <a :href="progress.report.markdownUrl">Baixar relatório Markdown</a>
          <a :href="progress.report.jsonUrl">Baixar dados JSON</a>
          <span>Arquivos: {{ progress.report.reportDirectory }}</span>
        </div>
        <div v-if="finalResults.length > 0" class="load-test-results-wrap">
          <table class="load-test-results">
            <thead>
              <tr>
                <th>Cenário</th><th>Concorrência</th><th>HTTP/s</th><th>Financeiras/s</th>
                <th>Rejeições/s</th><th>Replays/s</th><th>Mín.</th><th>Média</th><th>Máx.</th>
                <th>p50</th><th>p95</th><th>p99</th><th>Erros</th><th>Integridade</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="result in finalResults" :key="`${result.scenario}-${result.repetition}-${result.concurrency}`">
                <td>{{ scenarioLabel(result.scenario) }} · repetição {{ result.repetition }}</td>
                <td>{{ result.concurrency }}</td>
                <td>{{ decimal(result.httpRequestsPerSecond) }}</td>
                <td>{{ decimal(result.financialOperationsPerSecond) }}</td>
                <td>{{ decimal(result.businessRejectionsPerSecond) }}</td>
                <td>{{ decimal(result.replaysPerSecond) }}</td>
                <td>{{ decimal(result.latencies.minimumMilliseconds) }} ms</td>
                <td>{{ decimal(result.latencies.meanMilliseconds) }} ms</td>
                <td>{{ decimal(result.latencies.maximumMilliseconds) }} ms</td>
                <td>{{ decimal(result.latencies.p50Milliseconds) }} ms</td>
                <td>{{ decimal(result.latencies.p95Milliseconds) }} ms</td>
                <td>{{ decimal(result.latencies.p99Milliseconds) }} ms</td>
                <td>{{ result.operationalErrors }} (4xx {{ result.http4xx }}, 5xx {{ result.http5xx }})</td>
                <td>{{ result.failedChecks.length === 0 ? `${result.passedChecks} aprovadas` : `${result.failedChecks.length} falha(s)` }}</td>
              </tr>
            </tbody>
          </table>
          <details v-for="result in finalResults" :key="`detalhe-${result.scenario}-${result.repetition}-${result.concurrency}`" class="load-test-details">
            <summary>{{ scenarioLabel(result.scenario) }} · rejeições {{ result.businessRejected }} · replays {{ result.replays }} · conflitos de lock {{ result.lockConflicts ?? 'N/A' }} · outbox pendente {{ result.outboxPending ?? 'N/A' }}</summary>
            <ul v-if="result.failedChecks.length > 0">
              <li v-for="failure in result.failedChecks" :key="failure">{{ failure }}</li>
            </ul>
            <p v-else>Verificações financeiras aprovadas. Outbox publicada: {{ result.outboxPublished ?? 'N/A' }}; atraso máximo: {{ decimal(result.outboxLagMaximumSeconds) }} s; drenagem: {{ decimal(result.outboxDrainMilliseconds) }} ms.</p>
            <p v-if="result.prometheusUnavailableSnapshots > 0">Prometheus indisponível em {{ result.prometheusUnavailableSnapshots }} coleta(s); consulte o relatório JSON para os detalhes.</p>
            <p v-if="result.error">{{ result.error }}</p>
          </details>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.load-test-card { margin: 18px 0 24px; overflow: hidden; border: 1px solid #34304f; border-radius: 18px; background: linear-gradient(145deg, #151a2b, #111624 68%); box-shadow: 0 16px 40px #0002; color: #e9edf7; }
.load-test-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 24px 26px 18px; border-bottom: 1px solid #ffffff12; }
.load-test-kicker { margin: 0 0 8px; color: #b9a4ff; font-size: 10px; font-weight: 800; letter-spacing: .14em; }
.load-test-heading h2 { margin: 0; color: #fff; font-size: 24px; }
.load-test-description { max-width: 720px; margin: 8px 0 0; color: #aab6cb; font-size: 13px; line-height: 1.55; }
.load-test-state { display: inline-flex; align-items: center; gap: 8px; flex: 0 0 auto; padding: 8px 11px; border: 1px solid #34415b; border-radius: 999px; color: #aab6cb; font-size: 12px; }
.load-test-state span { width: 7px; height: 7px; border-radius: 50%; background: #8291ab; }
.load-test-state-active { border-color: #634bd0; color: #d4c8ff; }
.load-test-state-active span { background: #a68cff; box-shadow: 0 0 10px #a68cff; }
.load-test-notice, .load-test-persistent-warning { display: flex; flex-direction: column; gap: 5px; margin: 18px 22px; padding: 14px 16px; border: 1px solid #5e4d2d; border-radius: 12px; background: #2a2419; color: #e9d5a7; font-size: 12px; line-height: 1.5; }
.load-test-notice strong, .load-test-persistent-warning strong { color: #f3d993; }
.load-test-refresh { align-self: flex-start; padding: 7px 10px; border: 1px solid #665638; border-radius: 8px; background: #342a1a; color: #f1d994; cursor: pointer; font: inherit; }
.load-test-form { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; padding: 20px 22px 22px; }
.load-test-form label { display: flex; flex-direction: column; gap: 7px; color: #cbd4e4; font-size: 12px; font-weight: 650; }
.load-test-form input, .load-test-form select { width: 100%; min-height: 40px; padding: 9px 11px; border: 1px solid #36445e; border-radius: 9px; outline: none; background: #0d1422; color: #f4f6fb; font: inherit; }
.load-test-form input:focus, .load-test-form select:focus { border-color: #a78bfa; box-shadow: 0 0 0 3px #a78bfa22; }
.load-test-form small { color: #8291ab; font-size: 10px; font-weight: 400; }
.load-test-actions { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 8px; grid-column: 1 / -1; }
.load-test-start { min-height: 42px; padding: 0 18px; border: 0; border-radius: 10px; background: linear-gradient(135deg, #8056f5, #5a3bc7); color: #fff; cursor: pointer; font: inherit; font-size: 13px; font-weight: 750; }
.load-test-start:disabled { cursor: not-allowed; opacity: .55; }
.load-test-actions span { color: #8291ab; font-size: 11px; }
.load-test-error { margin: 0 22px 18px; color: #ff9eaa; font-size: 12px; }
.load-test-progress { margin: 0 22px 22px; overflow: hidden; border: 1px solid #2d3951; border-radius: 12px; background: #0d1422; }
.load-test-progress-title { display: flex; justify-content: space-between; gap: 16px; padding: 14px 16px; color: #aab6cb; font-size: 11px; }
.load-test-progress-title div { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.load-test-progress-title strong { color: #eef1f8; font-size: 13px; }
.load-test-progress-title > span { flex: 0 0 auto; }
.load-test-report-links { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 0 16px 14px; color: #8291ab; font-size: 11px; }
.load-test-report-links a { padding: 7px 9px; border: 1px solid #4b3b78; border-radius: 8px; color: #c7b5ff; text-decoration: none; }
.load-test-report-links a:hover { background: #221b39; }
.load-test-results-wrap { overflow-x: auto; border-top: 1px solid #ffffff12; }
.load-test-results { width: 100%; border-collapse: collapse; white-space: nowrap; text-align: left; font-size: 11px; }
.load-test-results th, .load-test-results td { padding: 10px 12px; border-bottom: 1px solid #ffffff0b; }
.load-test-results th { color: #9eabc1; background: #111a2a; font-weight: 650; }
.load-test-results td { color: #e1e7f1; }
.load-test-details { padding: 11px 14px; border-bottom: 1px solid #ffffff0b; color: #b8c2d4; font-size: 11px; }
.load-test-details summary { cursor: pointer; }
.load-test-details p { margin: 8px 0 0; color: #96a5bc; }
.load-test-details li { margin: 5px 0; color: #ffb5bd; }
@media (max-width: 820px) { .load-test-form { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 560px) { .load-test-heading { flex-direction: column; padding: 19px; } .load-test-form { grid-template-columns: 1fr; padding: 17px; } .load-test-progress { margin-right: 14px; margin-left: 14px; } .load-test-progress-title { flex-direction: column; } }
</style>
