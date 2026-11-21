export type FetchFn = typeof fetch;

export interface FetchJsonOptions {
  /** Etiqueta para los logs (p. ej. "bcrp", "twelvedata"). */
  label: string;
  /** Intentos totales (1 = sin reintento). Por defecto 2: un reintento. */
  attempts?: number;
  timeoutMs?: number;
  /** Espera antes del reintento. */
  retryDelayMs?: number;
  fetchFn?: FetchFn;
}

export class FetchJsonError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "FetchJsonError";
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * GET con timeout y un reintento ante errores transitorios (red, timeout, 429, 5xx,
 * cuerpo vacío o JSON inválido). Errores 4xx no transitorios no se reintentan.
 * La URL nunca debe contener credenciales: se escribe en los logs.
 */
export async function fetchJson(
  url: string,
  init: RequestInit,
  opts: FetchJsonOptions,
): Promise<unknown> {
  const attempts = opts.attempts ?? 2;
  const fetchFn = opts.fetchFn ?? fetch;
  let lastError: FetchJsonError = new FetchJsonError("sin intentos", null);

  for (let i = 1; i <= attempts; i++) {
    let retryable = true;
    try {
      const res = await fetchFn(url, {
        ...init,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
      const text = await res.text();
      if (!res.ok) {
        lastError = new FetchJsonError(`HTTP ${String(res.status)}`, res.status);
        retryable = RETRYABLE_STATUS.has(res.status);
      } else if (text.trim() === "") {
        lastError = new FetchJsonError("respuesta vacía", res.status);
      } else {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          lastError = new FetchJsonError("JSON inválido", res.status);
        }
      }
    } catch (err) {
      const timeout = err instanceof DOMException && err.name === "TimeoutError";
      lastError = new FetchJsonError(
        timeout ? "timeout" : `error de red: ${err instanceof Error ? err.message : String(err)}`,
        null,
      );
    }
    console.warn(
      `[${opts.label}] intento ${String(i)}/${String(attempts)} falló: ${lastError.message}`,
    );
    if (!retryable) break;
    if (i < attempts && (opts.retryDelayMs ?? 1000) > 0) {
      await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 1000));
    }
  }
  throw lastError;
}
