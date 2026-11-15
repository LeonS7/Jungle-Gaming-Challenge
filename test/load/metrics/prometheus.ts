/** Esta página interpreta amostras Prometheus e calcula deltas sem somar gauges. */
import type { PrometheusSample, PrometheusSnapshot } from '../types.js';

const SAMPLE_PATTERN = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|NaN|[+-]?Inf)$/;
const TYPE_PATTERN = /^#\s*TYPE\s+([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(counter|gauge|histogram|summary|untyped)\s*$/;
const LABEL_PATTERN = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g;

function decodeLabel(value: string): string {
  return value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function parseLabels(source: string | undefined): Readonly<Record<string, string>> {
  const labels: Record<string, string> = {};
  if (!source) {
    return labels;
  }
  for (const match of source.matchAll(LABEL_PATTERN)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) {
      labels[name] = decodeLabel(value);
    }
  }
  return labels;
}

export function parsePrometheusText(text: string): readonly PrometheusSample[] {
  const samples: PrometheusSample[] = [];
  const metricTypes = new Map<string, PrometheusSample['metricType']>();
  for (const line of text.split(/\r?\n/)) {
    const typeMatch = TYPE_PATTERN.exec(line.trim());
    if (typeMatch?.[1] && typeMatch[2]) {
      metricTypes.set(typeMatch[1], typeMatch[2] as NonNullable<PrometheusSample['metricType']>);
    }
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const match = SAMPLE_PATTERN.exec(line.trim());
    if (!match) {
      continue;
    }
    const metric = match[1];
    const rawValue = match[3];
    const value = rawValue === undefined ? Number.NaN : Number(rawValue);
    if (metric && Number.isFinite(value)) {
      const baseMetric = metric.replace(/_(?:bucket|sum|count)$/, '');
      const metricType = metricTypes.get(metric) ?? metricTypes.get(baseMetric);
      samples.push({
        metric,
        labels: parseLabels(match[2]),
        value,
        ...(metricType ? { metricType } : {}),
      });
    }
  }
  return samples;
}

export async function capturePrometheusSnapshots(
  apiUrls: readonly string[],
  intervalSeconds: number,
  durationMilliseconds: number,
  readMetrics: (apiUrl: string) => Promise<string>,
  onSnapshot?: (snapshot: PrometheusSnapshot) => void,
): Promise<readonly PrometheusSnapshot[]> {
  const snapshots: PrometheusSnapshot[] = [];
  const finishAt = Date.now() + durationMilliseconds;
  do {
    const capturedAt = new Date().toISOString();
    const batch = await Promise.all(apiUrls.map(async (apiUrl) => ({
      apiUrl,
      capturedAt,
      samples: parsePrometheusText(await readMetrics(apiUrl)),
    })));
    for (const snapshot of batch) {
      snapshots.push(snapshot);
      onSnapshot?.(snapshot);
    }
    const remaining = finishAt - Date.now();
    if (remaining <= 0) {
      break;
    }
    await Bun.sleep(Math.min(intervalSeconds * 1000, remaining));
  } while (Date.now() <= finishAt);
  return snapshots;
}

function sampleKey(sample: PrometheusSample): string {
  const labels = Object.entries(sample.labels).sort(([left], [right]) => left.localeCompare(right));
  return sample.metric + JSON.stringify(labels);
}

export interface PrometheusDelta {
  readonly counters: Readonly<Record<string, number>>;
  readonly gauges: Readonly<Record<string, number>>;
}

function latestSnapshot(
  snapshots: readonly PrometheusSnapshot[],
  apiUrl: string,
): PrometheusSnapshot | undefined {
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index];
    if (snapshot?.apiUrl === apiUrl) {
      return snapshot;
    }
  }
  return undefined;
}

export function calculatePrometheusDelta(
  before: readonly PrometheusSnapshot[],
  after: readonly PrometheusSnapshot[],
): PrometheusDelta {
  const counters: Record<string, number> = {};
  const gaugesByName: Record<string, number[]> = {};
  const urls = [...new Set(after.map((snapshot) => snapshot.apiUrl))];

  for (const apiUrl of urls) {
    const start = latestSnapshot(before, apiUrl);
    const end = latestSnapshot(after, apiUrl);
    if (!start || start.error || start.samples.length === 0 || !end || end.error || end.samples.length === 0) {
      continue;
    }
    const startByKey = new Map<string, PrometheusSample>();
    for (const sample of start?.samples ?? []) {
      startByKey.set(sampleKey(sample), sample);
    }
    for (const sample of end.samples) {
      const key = sampleKey(sample);
      if (
        sample.metricType === 'gauge' ||
        sample.metricType === undefined &&
          (sample.metric === 'outbox_lag_seconds' || sample.metric === 'sqs_dlq_visible_messages')
      ) {
        (gaugesByName[sample.metric] ??= []).push(sample.value);
        continue;
      }
      const previous = startByKey.get(key)?.value ?? 0;
      const delta = sample.value >= previous ? sample.value - previous : sample.value;
      counters[key] = (counters[key] ?? 0) + delta;
    }
  }
  const gauges: Record<string, number> = {};
  for (const [name, values] of Object.entries(gaugesByName)) {
    gauges[name] = Math.max(...values);
  }
  return { counters, gauges };
}
