import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { isForexOpen, isLimaSessionOpen } from "./market";
import { limaDate } from "./time";

/** Límites de rango para que ninguna consulta lea más de lo razonable. */
const MAX_OFFICIAL_DAYS = 400;
const LIVE_DAYS = { "1d": 1, "5d": 5, "1m": 31 } as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isoDate = z
  .string()
  .regex(DATE_RE, "Formato YYYY-MM-DD")
  // Ida y vuelta: rechaza fechas imposibles (2026-02-30) que Date desborda al mes siguiente.
  .refine((d) => {
    const t = Date.parse(`${d}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
  }, "Fecha inválida");

interface LiveRow {
  ts: number;
  price: number;
}
interface BcrpRow {
  date: string;
  compra: number | null;
  venta: number | null;
}

const iso = (ts: number) => new Date(ts * 1000).toISOString();

function result(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}
function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

async function latestLive(db: D1Database) {
  return db
    .prepare("SELECT ts, price FROM live_rates WHERE is_outlier = 0 ORDER BY ts DESC LIMIT 1")
    .first<LiveRow>();
}
async function latestOfficial(db: D1Database, onOrBefore?: string) {
  return onOrBefore
    ? db
        .prepare(
          "SELECT date, compra, venta FROM bcrp_rates WHERE date <= ? ORDER BY date DESC LIMIT 1",
        )
        .bind(onOrBefore)
        .first<BcrpRow>()
    : db
        .prepare("SELECT date, compra, venta FROM bcrp_rates ORDER BY date DESC LIMIT 1")
        .first<BcrpRow>();
}

/**
 * Envuelve un handler: registra el error real y devuelve un mensaje genérico, para no
 * filtrar detalles internos (p. ej. nombres de tablas de D1) al cliente MCP.
 */
function safeTool<A extends unknown[]>(
  name: string,
  fn: (...args: A) => Promise<ReturnType<typeof result>>,
) {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error(`[mcp] ${name}: ${err instanceof Error ? err.message : String(err)}`);
      return errorResult("Error interno al consultar los datos. Intenta de nuevo más tarde.");
    }
  };
}

/** Explicación corta en español de la comparación vivo vs. oficial. */
export function explain(live: number, off: BcrpRow): string {
  const ref = off.venta ?? off.compra;
  if (ref === null) return `El BCRP no publicó valores para ${off.date}.`;
  const pct = ((live - ref) / ref) * 100;
  const which = off.venta !== null ? "venta" : "compra";
  const rel =
    Math.abs(pct) < 0.05
      ? "prácticamente igual al"
      : pct > 0
        ? `${Math.abs(pct).toFixed(2)} % por encima del`
        : `${Math.abs(pct).toFixed(2)} % por debajo del`;
  return `El precio en vivo (S/ ${live.toFixed(4)}) está ${rel} tipo de cambio oficial de ${which} del BCRP del ${off.date} (S/ ${ref.toFixed(4)}). El oficial es un promedio diario del mercado interbancario; el precio en vivo es una cotización puntual de Twelve Data.`;
}

/** Crea un servidor MCP nuevo por petición (recomendado: sin estado compartido entre clientes). */
export function createServer(env: Env): McpServer {
  const server = new McpServer({ name: "usd-monitor", version: "1.0.0" });

  server.registerTool(
    "get_live_rate",
    {
      description:
        "Devuelve el último tipo de cambio USD/PEN en vivo (Twelve Data, lectura cada 5 min, sin lecturas atípicas) y si el mercado forex está abierto.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
    },
    safeTool("get_live_rate", async () => {
      const r = await latestLive(env.DB);
      const now = new Date();
      return result({
        price: r?.price ?? null,
        ts: r ? iso(r.ts) : null,
        market_open: isForexOpen(now),
        lima_session_open: isLimaSessionOpen(now),
        note: r ? undefined : "Aún no hay lecturas en vivo.",
      });
    }),
  );

  server.registerTool(
    "get_live_history",
    {
      description:
        "Historial del tipo de cambio USD/PEN en vivo. range: '1d' (crudo, cada 5 min), '5d' (crudo) o '1m' (promedio por hora). Excluye lecturas atípicas.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        range: z.enum(["1d", "5d", "1m"]).describe("Rango: 1d, 5d o 1m"),
      }),
    },
    safeTool("get_live_history", async ({ range }) => {
      const to = Math.floor(Date.now() / 1000);
      const from = to - LIVE_DAYS[range] * 86_400;
      const stmt =
        range === "1m"
          ? env.DB.prepare(
              `SELECT MAX(ts) AS ts, ROUND(AVG(price), 6) AS price FROM live_rates
               WHERE is_outlier = 0 AND ts >= ? AND ts <= ? GROUP BY ts / 3600 ORDER BY ts`,
            ).bind(from, to)
          : env.DB.prepare(
              "SELECT ts, price FROM live_rates WHERE is_outlier = 0 AND ts >= ? AND ts <= ? ORDER BY ts",
            ).bind(from, to);
      const { results } = await stmt.all<LiveRow>();
      const prices = results.map((r) => r.price);
      return result({
        range,
        from: iso(from),
        to: iso(to),
        count: results.length,
        min: prices.length ? Math.min(...prices) : null,
        max: prices.length ? Math.max(...prices) : null,
        points: results.map((r) => ({ ts: iso(r.ts), price: r.price })),
      });
    }),
  );

  server.registerTool(
    "get_official_rate",
    {
      description:
        "Tipo de cambio interbancario oficial del BCRP (compra y venta) para una fecha YYYY-MM-DD. Si no hay dato ese día (fin de semana, feriado), devuelve el último día hábil anterior. Sin fecha: el más reciente.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        date: isoDate.optional().describe("Fecha en formato YYYY-MM-DD (hora de Lima)"),
      }),
    },
    safeTool("get_official_rate", async ({ date }) => {
      const r = await latestOfficial(env.DB, date);
      if (!r)
        return errorResult(
          date ? `No hay datos del BCRP en o antes de ${date}.` : "Aún no hay datos del BCRP.",
        );
      return result({ requested: date ?? null, ...r, exact: date ? r.date === date : true });
    }),
  );

  server.registerTool(
    "get_official_history",
    {
      description: `Historial del tipo de cambio oficial del BCRP entre dos fechas YYYY-MM-DD (inclusive). Máximo ${String(MAX_OFFICIAL_DAYS)} días. Los valores no publicados ("n.d.") vienen como null.`,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        from: isoDate.describe("Fecha inicial YYYY-MM-DD"),
        to: isoDate.describe("Fecha final YYYY-MM-DD"),
      }),
    },
    safeTool("get_official_history", async ({ from, to }) => {
      const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
      if (days < 0) return errorResult("'from' debe ser anterior o igual a 'to'.");
      if (days + 1 > MAX_OFFICIAL_DAYS)
        return errorResult(`El rango máximo es de ${String(MAX_OFFICIAL_DAYS)} días.`);
      const { results } = await env.DB.prepare(
        "SELECT date, compra, venta FROM bcrp_rates WHERE date >= ? AND date <= ? ORDER BY date",
      )
        .bind(from, to)
        .all<BcrpRow>();
      return result({ from, to, count: results.length, data: results });
    }),
  );

  server.registerTool(
    "compare_live_vs_official",
    {
      description:
        "Compara el último precio USD/PEN en vivo con el tipo de cambio oficial más reciente del BCRP (compra y venta): diferencia absoluta y porcentual.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
    },
    safeTool("compare_live_vs_official", async () => {
      const [live, off] = await Promise.all([latestLive(env.DB), latestOfficial(env.DB)]);
      if (!live || !off) return errorResult("Faltan datos en vivo o del BCRP para comparar.");
      const diff = (ref: number | null) =>
        ref === null
          ? null
          : {
              abs: Number((live.price - ref).toFixed(6)),
              pct: Number((((live.price - ref) / ref) * 100).toFixed(4)),
            };
      return result({
        live: { price: live.price, ts: iso(live.ts) },
        official: off,
        official_is_today: off.date === limaDate(new Date()),
        vs_compra: diff(off.compra),
        vs_venta: diff(off.venta),
        explanation: explain(live.price, off),
      });
    }),
  );

  return server;
}

/** Handler de /mcp (Streamable HTTP, sin estado). Solo lectura: no expone el endpoint admin. */
export function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Un servidor nuevo por petición (factory), Streamable HTTP sin estado.
  return createMcpHandler(() => createServer(env), {
    route: "/mcp",
    // Protección contra DNS rebinding: solo el host de producción y localhost (wrangler dev).
    allowedHostnames: ["usd-monitor.gcs14.workers.dev", "localhost", "127.0.0.1"],
    onerror: (err) => {
      console.error(`[mcp] ${err.message}`);
    },
  })(request, env, ctx);
}
