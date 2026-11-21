import { fetchJson, type FetchFn } from "../fetch-json";
import { limaDate } from "../time";
import { parseBcrpResponse, type BcrpRow } from "./parse";

/** Series diarias del BCRP: TC interbancario compra (PD04637PD) y venta (PD04638PD). */
export const BCRP_SERIES = "PD04637PD-PD04638PD";
const BCRP_API = "https://estadisticas.bcrp.gob.pe/estadisticas/series/api";

/** Días que mira el cron horario (cubre feriados largos y publicaciones tardías). */
export const BCRP_RECENT_DAYS = 10;
/** Días de la carga inicial: más de 1 año. */
export const BCRP_BACKFILL_DAYS = 400;

/** D1 admite 100 parámetros por consulta: 4 por fila → 25 filas por INSERT. */
const ROWS_PER_STATEMENT = 25;

export function bcrpUrl(from: string, to: string): string {
  return `${BCRP_API}/${BCRP_SERIES}/json/${from}/${to}`;
}

export async function fetchBcrpRange(
  from: string,
  to: string,
  fetchFn?: FetchFn,
): Promise<BcrpRow[]> {
  const body = await fetchJson(
    bcrpUrl(from, to),
    { headers: { accept: "application/json" } },
    { label: "bcrp", timeoutMs: 15_000, ...(fetchFn ? { fetchFn } : {}) },
  );
  return parseBcrpResponse(body);
}

/**
 * Upsert por fecha. Un valor "n.d." (null) nunca pisa un valor ya guardado.
 * Devuelve el número de filas escritas.
 */
export async function upsertBcrpRows(
  db: D1Database,
  rows: BcrpRow[],
  fetchedAt: number,
): Promise<number> {
  if (rows.length === 0) return 0;
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const chunk = rows.slice(i, i + ROWS_PER_STATEMENT);
    const placeholders = chunk.map(() => "(?, ?, ?, ?)").join(", ");
    statements.push(
      db
        .prepare(
          `INSERT INTO bcrp_rates (date, compra, venta, fetched_at) VALUES ${placeholders}
           ON CONFLICT(date) DO UPDATE SET
             compra = COALESCE(excluded.compra, bcrp_rates.compra),
             venta = COALESCE(excluded.venta, bcrp_rates.venta),
             fetched_at = excluded.fetched_at`,
        )
        .bind(...chunk.flatMap((r) => [r.date, r.compra, r.venta, fetchedAt])),
    );
  }
  await db.batch(statements);
  return rows.length;
}

export interface BcrpIngestResult {
  from: string;
  to: string;
  rows: number;
  latest: string | null;
}

/** Descarga los últimos `days` días (fechas de Lima) y hace upsert. Lanza si falla. */
export async function ingestBcrp(
  env: Pick<Env, "DB">,
  days: number,
  now: Date = new Date(),
  fetchFn?: FetchFn,
): Promise<BcrpIngestResult> {
  const to = limaDate(now);
  const from = limaDate(new Date(now.getTime() - days * 86_400_000));
  const rows = await fetchBcrpRange(from, to, fetchFn);
  await upsertBcrpRows(env.DB, rows, Math.floor(now.getTime() / 1000));
  const latest = rows.reduce<string | null>(
    (acc, r) => (acc === null || r.date > acc ? r.date : acc),
    null,
  );
  return { from, to, rows: rows.length, latest };
}

/** Handler del cron horario: nunca lanza, deja un log claro del resultado. */
export async function runBcrpCron(env: Pick<Env, "DB">, now: Date = new Date()): Promise<void> {
  try {
    const r = await ingestBcrp(env, BCRP_RECENT_DAYS, now);
    console.log(
      `[bcrp] ok: ${String(r.rows)} fechas ${r.from}..${r.to}, última ${r.latest ?? "ninguna"}`,
    );
  } catch (err) {
    console.error(`[bcrp] falló la ingesta: ${err instanceof Error ? err.message : String(err)}`);
  }
}
