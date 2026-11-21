/** Meses tal como los devuelve la API del BCRP (septiembre aparece como "Set"). */
const MONTHS: Record<string, number> = {
  ene: 1,
  feb: 2,
  mar: 3,
  abr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  ago: 8,
  set: 9,
  sep: 9,
  oct: 10,
  nov: 11,
  dic: 12,
};

/** "20.Nov.26" → "2026-11-20". Devuelve null si el formato o la fecha no son válidos. */
export function parseBcrpDate(raw: string): string | null {
  const m = /^(\d{1,2})\.([A-Za-z]{3})\.(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = MONTHS[(m[2] ?? "").toLowerCase()];
  const year = 2000 + Number(m[3]);
  if (month === undefined || day < 1) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${String(year)}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "3.4588" → 3.4588; "n.d." u otro valor no numérico o no positivo → null. */
export function parseBcrpValue(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface BcrpRow {
  date: string;
  compra: number | null;
  venta: number | null;
}

interface BcrpResponse {
  periods?: unknown;
}

/**
 * Convierte la respuesta JSON del BCRP (series compra-venta) en filas.
 * - Fechas con ambos valores "n.d." se descartan (no hay dato).
 * - Si solo uno es "n.d.", se conserva la fila con ese valor en null.
 * - Lanza si la respuesta no tiene `periods` (error o HTML del BCRP).
 */
export function parseBcrpResponse(body: unknown): BcrpRow[] {
  const periods = (body as BcrpResponse | null)?.periods;
  if (!Array.isArray(periods)) throw new Error("respuesta BCRP sin 'periods'");
  const rows: BcrpRow[] = [];
  for (const p of periods as { name?: unknown; values?: unknown }[]) {
    if (typeof p.name !== "string" || !Array.isArray(p.values)) continue;
    const date = parseBcrpDate(p.name);
    if (!date) {
      console.warn(`[bcrp] fecha no reconocida, se ignora: ${p.name.slice(0, 40)}`);
      continue;
    }
    const compra = parseBcrpValue(p.values[0]);
    const venta = parseBcrpValue(p.values[1]);
    if (compra === null && venta === null) continue;
    rows.push({ date, compra, venta });
  }
  return rows;
}
