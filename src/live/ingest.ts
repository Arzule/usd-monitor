import { isForexOpen } from "../market";
import { classify, DEFAULT_OUTLIER_CONFIG, type OutlierConfig } from "./outlier";
import { fetchQuote, type Quote } from "./twelvedata";
import type { FetchFn } from "../fetch-json";

export const LIVE_SOURCE = "twelvedata";
/** Retención de live_rates. */
export const RETENTION_DAYS = 90;
/**
 * Twelve Data Basic: 8 créditos/min. Dejamos margen para que una lectura
 * forzada coincidiendo con el cron (y sus reintentos) nunca exceda el límite.
 */
export const CREDITS_PER_MINUTE = 6;
/** Twelve Data Basic: 800 créditos/día. Tope local con margen (el cron usa ~288). */
export const CREDITS_PER_DAY = 750;

export class CreditLimitError extends Error {
  constructor() {
    super(
      `límite local de créditos alcanzado (${String(CREDITS_PER_MINUTE)}/min o ${String(CREDITS_PER_DAY)}/día)`,
    );
    this.name = "CreditLimitError";
  }
}

/** Lee la configuración del filtro desde vars (con valores por defecto seguros). */
export function outlierConfigFromEnv(env: Partial<Record<string, unknown>>): OutlierConfig {
  const num = (v: unknown, def: number, min: number, max: number): number => {
    const n = typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) && n >= min && n <= max ? n : def;
  };
  const window = Math.round(num(env.OUTLIER_WINDOW, DEFAULT_OUTLIER_CONFIG.window, 3, 100));
  return {
    threshold: num(env.OUTLIER_THRESHOLD, DEFAULT_OUTLIER_CONFIG.threshold, 0.0001, 0.5),
    window,
    minSamples: Math.round(
      num(env.OUTLIER_MIN_SAMPLES, Math.min(DEFAULT_OUTLIER_CONFIG.minSamples, window), 1, window),
    ),
    maxAgeSeconds: Math.round(
      num(env.OUTLIER_MAX_AGE_SECONDS, DEFAULT_OUTLIER_CONFIG.maxAgeSeconds, 600, 7 * 86_400),
    ),
  };
}

/**
 * Registra un intento de llamada a Twelve Data, o lanza CreditLimitError si en el
 * último minuto ya hubo CREDITS_PER_MINUTE intentos. Se cuenta cada intento,
 * incluidos los reintentos, porque cada uno puede consumir un crédito.
 */
export async function reserveCredit(db: D1Database, nowMs: number): Promise<void> {
  const now = Math.floor(nowMs / 1000);
  // Chequeo e inserción en una sola sentencia (atómica en D1): dos lecturas
  // concurrentes no pueden pasar ambas el límite.
  const res = await db
    .prepare(
      `INSERT INTO twelve_calls (ts)
       SELECT ?1 WHERE
         (SELECT COUNT(*) FROM twelve_calls WHERE ts > ?1 - 60) < ?2 AND
         (SELECT COUNT(*) FROM twelve_calls WHERE ts > ?1 - 86400) < ?3`,
    )
    .bind(now, CREDITS_PER_MINUTE, CREDITS_PER_DAY)
    .run();
  if (res.meta.changes === 0) throw new CreditLimitError();
}

export interface LiveResult {
  status: "stored" | "duplicate" | "skipped_market_closed";
  quote?: Quote;
  isOutlier?: boolean;
  median?: number | null;
}

export interface LiveOptions {
  now?: Date;
  /** true = lectura forzada (admin): ignora el horario de mercado, no los créditos. */
  force?: boolean;
  fetchFn?: FetchFn;
  retryDelayMs?: number;
}

/** Lee una cotización, la clasifica y la guarda. Lanza si la API falla. */
export async function ingestLive(env: Env, opts: LiveOptions = {}): Promise<LiveResult> {
  const now = opts.now ?? new Date();
  if (!opts.force && !isForexOpen(now)) {
    console.log("[live] mercado cerrado, sin llamada");
    return { status: "skipped_market_closed" };
  }
  if (!env.TWELVE_DATA_API_KEY) throw new Error("falta TWELVE_DATA_API_KEY");

  const quote = await fetchQuote(env.TWELVE_DATA_SYMBOL, env.TWELVE_DATA_API_KEY, {
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    ...(opts.retryDelayMs !== undefined ? { retryDelayMs: opts.retryDelayMs } : {}),
    onAttempt: () => reserveCredit(env.DB, Date.now()),
  });

  const config = outlierConfigFromEnv(env as unknown as Record<string, unknown>);
  const { results } = await env.DB.prepare(
    "SELECT price FROM live_rates WHERE is_outlier = 0 AND ts < ? AND ts >= ? ORDER BY ts DESC LIMIT ?",
  )
    .bind(quote.ts, quote.ts - config.maxAgeSeconds, config.window)
    .all<{ price: number }>();
  const verdict = classify(
    quote.price,
    results.map((r) => r.price),
    config,
  );

  const res = await env.DB.prepare(
    "INSERT OR IGNORE INTO live_rates (ts, price, source, is_outlier) VALUES (?, ?, ?, ?)",
  )
    .bind(quote.ts, quote.price, LIVE_SOURCE, verdict.isOutlier ? 1 : 0)
    .run();

  if (res.meta.changes === 0) {
    console.log(`[live] sin cotización nueva (ts ${String(quote.ts)} ya guardado)`);
    return { status: "duplicate", quote };
  }
  const flag = verdict.isOutlier
    ? ` OUTLIER (desvío ${((verdict.deviation ?? 0) * 100).toFixed(2)}% de la mediana ${String(verdict.median)})`
    : "";
  console.log(`[live] guardado ${String(quote.price)} @ ${String(quote.ts)}${flag}`);
  return { status: "stored", quote, isOutlier: verdict.isOutlier, median: verdict.median };
}

/** Borra lecturas de más de RETENTION_DAYS y el registro de créditos de más de 1 día. */
export async function cleanup(db: D1Database, nowMs: number): Promise<void> {
  const now = Math.floor(nowMs / 1000);
  const [live, calls] = await db.batch([
    db.prepare("DELETE FROM live_rates WHERE ts < ?").bind(now - RETENTION_DAYS * 86_400),
    db.prepare("DELETE FROM twelve_calls WHERE ts < ?").bind(now - 86_400),
  ]);
  console.log(
    `[cleanup] live_rates: ${String(live?.meta.changes ?? 0)} filas, twelve_calls: ${String(calls?.meta.changes ?? 0)}`,
  );
}

/** Handler del cron de 5 min: nunca lanza. La limpieza corre una vez al día (00:00 UTC). */
export async function runLiveCron(env: Env, scheduledTime: number): Promise<void> {
  const now = new Date(scheduledTime);
  try {
    await ingestLive(env, { now });
  } catch (err) {
    console.error(`[live] falló la lectura: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (now.getUTCHours() === 0 && now.getUTCMinutes() < 5) {
    try {
      await cleanup(env.DB, scheduledTime);
    } catch (err) {
      console.error(`[cleanup] falló: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
