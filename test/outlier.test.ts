import { describe, expect, it } from "vitest";
import { outlierConfigFromEnv } from "../src/live/ingest";
import { classify, DEFAULT_OUTLIER_CONFIG, median } from "../src/live/outlier";

describe("median", () => {
  it("impar, par y desordenado", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
  it("lista vacía lanza", () => {
    expect(() => median([])).toThrow();
  });
});

describe("classify", () => {
  const base = [3.4, 3.41, 3.39, 3.4, 3.405];

  it("arranque: con menos de minSamples nunca marca outlier", () => {
    expect(classify(100, [3.4, 3.4, 3.4, 3.4])).toEqual({
      isOutlier: false,
      median: null,
      deviation: null,
    });
    expect(classify(100, [])).toMatchObject({ isOutlier: false });
  });

  it("dentro del umbral (1%) → válido", () => {
    expect(classify(3.43, base)).toMatchObject({ isOutlier: false, median: 3.4 });
  });

  it("justo sobre el umbral → outlier; justo debajo → válido", () => {
    expect(classify(3.4 * 1.0101, base).isOutlier).toBe(true);
    expect(classify(3.4 * 1.0099, base).isOutlier).toBe(false);
    expect(classify(3.4 * 0.9899, base).isOutlier).toBe(true);
  });

  it("solo usa las últimas `window` lecturas", () => {
    const recent = [...Array<number>(12).fill(3.8), ...Array<number>(20).fill(3.4)];
    expect(classify(3.8, recent)).toMatchObject({ isOutlier: false, median: 3.8 });
  });

  it("minSamples nunca supera window", () => {
    expect(
      outlierConfigFromEnv({ OUTLIER_WINDOW: "3", OUTLIER_MIN_SAMPLES: "10" }).minSamples,
    ).toBe(3);
  });

  it("umbral configurable", () => {
    const cfg = { ...DEFAULT_OUTLIER_CONFIG, threshold: 0.001 };
    expect(classify(3.41, base, cfg).isOutlier).toBe(true);
  });
});

describe("outlierConfigFromEnv", () => {
  it("lee vars válidas y descarta valores fuera de rango", () => {
    expect(outlierConfigFromEnv({ OUTLIER_THRESHOLD: "0.02", OUTLIER_WINDOW: "20" })).toEqual({
      threshold: 0.02,
      window: 20,
      minSamples: 5,
      maxAgeSeconds: 7200,
    });
    expect(outlierConfigFromEnv({ OUTLIER_THRESHOLD: "abc", OUTLIER_WINDOW: "-1" })).toEqual(
      DEFAULT_OUTLIER_CONFIG,
    );
  });
});
