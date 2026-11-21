import { FetchJsonError, fetchJson, type FetchFn } from "../fetch-json";

const QUOTE_URL = "https://api.twelvedata.com/quote";

export interface Quote {
  /** epoch UTC (s) de la última cotización. */
  ts: number;
  price: number;
}

interface QuoteBody {
  status?: unknown;
  code?: unknown;
  message?: unknown;
  close?: unknown;
  last_quote_at?: unknown;
  timestamp?: unknown;
}

/** Códigos de error de Twelve Data que vale la pena reintentar (límite de créditos, error interno). */
const RETRYABLE_API_CODES = new Set([429, 500, 502, 503]);

export class TwelveDataError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "TwelveDataError";
  }
}

/** Valida la respuesta de /quote. Twelve Data puede devolver HTTP 200 con `status: "error"`. */
export function parseQuote(body: unknown): Quote {
  const b = (body ?? {}) as QuoteBody;
  if (b.status === "error") {
    const code = typeof b.code === "number" ? b.code : 0;
    const msg = typeof b.message === "string" ? b.message.slice(0, 200) : "sin mensaje";
    throw new TwelveDataError(`API error ${String(code)}: ${msg}`, RETRYABLE_API_CODES.has(code));
  }
  const price = typeof b.close === "string" ? Number(b.close) : NaN;
  // Solo last_quote_at: `timestamp` es el inicio de la vela diaria y haría que todas
  // las lecturas del día parezcan duplicadas.
  const ts = typeof b.last_quote_at === "number" ? b.last_quote_at : NaN;
  if (!Number.isFinite(price) || price <= 0) {
    throw new TwelveDataError("respuesta sin precio válido", false);
  }
  if (!Number.isInteger(ts) || ts <= 0) {
    throw new TwelveDataError("respuesta sin last_quote_at", false);
  }
  return { ts, price };
}

/**
 * GET /quote (1 crédito por llamada). La API key va en el header
 * `Authorization: apikey …`, nunca en la URL (que se escribe en logs).
 * Un reintento ante errores transitorios; `onAttempt` se llama antes de cada
 * intento para contabilizar créditos.
 */
export async function fetchQuote(
  symbol: string,
  apiKey: string,
  opts: { fetchFn?: FetchFn; retryDelayMs?: number; onAttempt?: () => Promise<void> } = {},
): Promise<Quote> {
  const url = `${QUOTE_URL}?symbol=${encodeURIComponent(symbol)}`;
  let last: Error = new Error("sin intentos");
  for (let attempt = 1; attempt <= 2; attempt++) {
    let retryable: boolean;
    try {
      await opts.onAttempt?.();
      const body = await fetchJson(
        url,
        { headers: { authorization: `apikey ${apiKey}`, accept: "application/json" } },
        { label: "twelvedata", attempts: 1, ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}) },
      );
      return parseQuote(body);
    } catch (err) {
      last = err instanceof Error ? err : new Error(String(err));
      retryable =
        err instanceof TwelveDataError
          ? err.retryable
          : err instanceof FetchJsonError
            ? err.retryable
            : false;
    }
    console.warn(`[live] intento ${String(attempt)}/2 falló: ${last.message}`);
    if (!retryable) break;
    if (attempt < 2) await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 1500));
  }
  throw last;
}
