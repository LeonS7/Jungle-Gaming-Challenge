/** Esta página calcula estatísticas somente a partir de latências medidas. */
export interface LatencyStatistics {
  readonly count: number;
  readonly minimumMilliseconds: number | null;
  readonly maximumMilliseconds: number | null;
  readonly meanMilliseconds: number | null;
  readonly p50Milliseconds: number | null;
  readonly p95Milliseconds: number | null;
  readonly p99Milliseconds: number | null;
}

function nearestRank(sortedValues: readonly number[], percentile: number): number | null {
  if (sortedValues.length === 0) {
    return null;
  }
  const rank = Math.max(1, Math.ceil(percentile * sortedValues.length));
  return sortedValues[rank - 1] ?? null;
}

export function calculateLatencyStatistics(values: readonly number[]): LatencyStatistics {
  const validValues = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (validValues.length === 0) {
    return {
      count: 0,
      minimumMilliseconds: null,
      maximumMilliseconds: null,
      meanMilliseconds: null,
      p50Milliseconds: null,
      p95Milliseconds: null,
      p99Milliseconds: null,
    };
  }

  const sortedValues = [...validValues].sort((left, right) => left - right);
  const total = validValues.reduce((sum, value) => sum + value, 0);
  return {
    count: validValues.length,
    minimumMilliseconds: sortedValues[0] ?? null,
    maximumMilliseconds: sortedValues.at(-1) ?? null,
    meanMilliseconds: total / validValues.length,
    p50Milliseconds: nearestRank(sortedValues, 0.50),
    p95Milliseconds: nearestRank(sortedValues, 0.95),
    p99Milliseconds: nearestRank(sortedValues, 0.99),
  };
}
