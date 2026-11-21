import { json } from "./http";
import { isForexOpen, isLimaSessionOpen } from "./market";
import { limaDate } from "./time";

/** Cabeceras comunes de la API pública: CORS abierto solo para lectura y cache corto. */
export function apiJson(body: unknown, maxAge: number, status = 200): Response {
  return json(body, {
    status,
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": status === 200 ? `public, max-age=${String(maxAge)}` : "no-store",
    },
  });
}

export const LIVE_RANGES = { "1d": 1, "5d": 5, "1m": 31 } as const;
export const BCRP_RANGES = { "1m": 31, "6m": 183, "1y": 366 } as const;
export type LiveRange = keyof typeof LIVE_RANGES;
export type BcrpRange = keyof typeof BCRP_RANGES;

/** En 1M se agrupa por hora (~744 puntos) para acotar tamaño y CPU; 1D/5D van crudos. */
const LIVE_BUCKET_SECONDS: Record<LiveRange, number> = { "1d": 0, "5d": 0, "1m": 3600 };

function isKey<T extends object>(obj: T, k: string | null): k is Extract<keyof T, string> {
  return k !== null && Object.prototype.hasOwnProperty.call(obj, k);
}

function badRequest(param: string, allowed: readonly string[]): Response {
  return apiJson({ error: "invalid_parameter", param, allowed }, 0, 400);
}

interface LiveRow {
  ts: number;
  price: number;
  is_outlier: number;
}

const toLive = (r: LiveRow) => ({ ts: r.ts, price: r.price, is_outlier: r.is_outlier === 1 });

async function latestLive(db: D1Database) {
  const r = await db
    .prepare(
      "SELECT ts, price, is_outlier FROM live_rates WHERE is_outlier = 0 ORDER BY ts DESC LIMIT 1",
    )
    .first<LiveRow>();
  return r ? toLive(r) : null;
}

async function latestBcrp(db: D1Database) {
  return db
    .prepare("SELECT date, compra, venta FROM bcrp_rates ORDER BY date DESC LIMIT 1")
    .first<{ date: string; compra: number | null; venta: number | null }>();
}

/** GET /api/health */
export async function health(env: Env, now = new Date()): Promise<Response> {
  const [live, bcrp] = await Promise.all([latestLive(env.DB), latestBcrp(env.DB)]);
  return apiJson(
    {
      status: "ok",
      now: Math.floor(now.getTime() / 1000),
      market_open: isForexOpen(now),
      lima_session_open: isLimaSessionOpen(now),
      last_live: live,
      last_bcrp_date: bcrp?.date ?? null,
    },
    30,
  );
}

/** GET /api/live/latest — última lectura válida (sin outliers). */
export async function liveLatest(env: Env): Promise<Response> {
  return apiJson({ data: await latestLive(env.DB) }, 60);
}

/** GET /api/live?range=1d|5d|1m[&include_outliers=true] */
export async function liveHistory(env: Env, url: URL, now = new Date()): Promise<Response> {
  const range = url.searchParams.get("range") ?? "1d";
  if (!isKey(LIVE_RANGES, range)) return badRequest("range", Object.keys(LIVE_RANGES));
  const inc = url.searchParams.get("include_outliers");
  if (inc !== null && inc !== "true" && inc !== "false") {
    return badRequest("include_outliers", ["true", "false"]);
  }
  const includeOutliers = inc === "true";
  const to = Math.floor(now.getTime() / 1000);
  const from = to - LIVE_RANGES[range] * 86_400;
  const bucket = LIVE_BUCKET_SECONDS[range];

  const valid = bucket
    ? env.DB.prepare(
        `SELECT MAX(ts) AS ts, ROUND(AVG(price), 6) AS price, 0 AS is_outlier FROM live_rates
         WHERE is_outlier = 0 AND ts >= ? AND ts <= ? GROUP BY ts / CAST(? AS INTEGER) ORDER BY ts`,
      ).bind(from, to, bucket)
    : env.DB.prepare(
        "SELECT ts, price, is_outlier FROM live_rates WHERE is_outlier = 0 AND ts >= ? AND ts <= ? ORDER BY ts",
      ).bind(from, to);
  const outliers = env.DB.prepare(
    "SELECT ts, price, is_outlier FROM live_rates WHERE is_outlier = 1 AND ts >= ? AND ts <= ? ORDER BY ts",
  ).bind(from, to);

  const [v, o] = await env.DB.batch<LiveRow>(includeOutliers ? [valid, outliers] : [valid]);
  const data = (v?.results ?? []).map(toLive);
  return apiJson(
    {
      range,
      from,
      to,
      bucket_seconds: bucket || null,
      include_outliers: includeOutliers,
      count: data.length,
      data,
      ...(includeOutliers ? { outliers: (o?.results ?? []).map(toLive) } : {}),
    },
    60,
  );
}

/** GET /api/bcrp/latest */
export async function bcrpLatest(env: Env): Promise<Response> {
  return apiJson({ data: await latestBcrp(env.DB) }, 300);
}

/** GET /api/bcrp?range=1m|6m|1y */
export async function bcrpHistory(env: Env, url: URL, now = new Date()): Promise<Response> {
  const range = url.searchParams.get("range") ?? "1m";
  if (!isKey(BCRP_RANGES, range)) return badRequest("range", Object.keys(BCRP_RANGES));
  const to = limaDate(now);
  const from = limaDate(new Date(now.getTime() - BCRP_RANGES[range] * 86_400_000));
  const { results } = await env.DB.prepare(
    "SELECT date, compra, venta FROM bcrp_rates WHERE date >= ? AND date <= ? ORDER BY date",
  )
    .bind(from, to)
    .all<{ date: string; compra: number | null; venta: number | null }>();
  return apiJson({ range, from, to, count: results.length, data: results }, 300);
}
