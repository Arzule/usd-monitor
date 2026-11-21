export interface OutlierConfig {
  /** Desviación relativa máxima respecto de la mediana (0.01 = 1%). */
  threshold: number;
  /** Cuántas lecturas válidas recientes se usan para la mediana. */
  window: number;
  /** Mínimo de lecturas válidas antes de marcar algo (arranque). */
  minSamples: number;
}

export const DEFAULT_OUTLIER_CONFIG: OutlierConfig = { threshold: 0.01, window: 12, minSamples: 5 };

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median de lista vacía");
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0);
}

export interface OutlierVerdict {
  isOutlier: boolean;
  median: number | null;
  deviation: number | null;
}

/**
 * Decide si `price` es anómalo comparándolo con la mediana de las últimas
 * lecturas válidas (`recentValid`, sin outliers). Con menos de `minSamples`
 * lecturas nunca marca nada.
 */
export function classify(
  price: number,
  recentValid: readonly number[],
  config: OutlierConfig = DEFAULT_OUTLIER_CONFIG,
): OutlierVerdict {
  const sample = recentValid.slice(0, config.window);
  if (sample.length < config.minSamples) return { isOutlier: false, median: null, deviation: null };
  const m = median(sample);
  const deviation = Math.abs(price - m) / m;
  return { isOutlier: deviation > config.threshold, median: m, deviation };
}
