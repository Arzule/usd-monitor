import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker, { CRON_LIVE } from "../src/index";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CREDITS_PER_DAY,
  CREDITS_PER_MINUTE,
  cleanup,
  ingestLive,
  reserveCredit,
  runLiveCron,
} from "../src/live/ingest";
import { parseQuote } from "../src/live/twelvedata";

const OPEN = new Date("2026-11-23T15:00:00Z"); // lunes
const CLOSED = new Date("2026-11-21T15:00:00Z"); // sábado

function quote(price: number, ts: number) {
  return { symbol: "USD/PEN", close: String(price), last_quote_at: ts, timestamp: ts - 100 };
}

/** Mock de fetch que crea una Response nueva en cada llamada. */
function mockFetch(...bodies: unknown[]) {
  const fn = vi.fn<typeof fetch>();
  for (const b of bodies) {
    fn.mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify(b))));
  }
  return fn;
}

const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
};

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM live_rates"),
    env.DB.prepare("DELETE FROM twelve_calls"),
  ]);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseQuote", () => {
  it("usa last_quote_at y convierte close", () => {
    expect(parseQuote(quote(3.38, 1_800_000_000))).toEqual({ ts: 1_800_000_000, price: 3.38 });
  });
  it("error de API con HTTP 200 → reintentable si es 429", () => {
    expect(() => parseQuote({ status: "error", code: 429, message: "x" })).toThrow(/429/);
  });
  it("sin precio → error", () => {
    expect(() => parseQuote({ close: "n/a", last_quote_at: 1 })).toThrow(/precio/);
  });
});

describe("ingestLive", () => {
  it("mercado cerrado: no llama a la API y deja el log", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchFn = vi.fn<typeof fetch>();
    const r = await ingestLive(env, { now: CLOSED, fetchFn });
    expect(r.status).toBe("skipped_market_closed");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("[live] mercado cerrado, sin llamada");
  });

  it("lectura forzada ignora el horario y guarda con la API key en el header", async () => {
    quiet();
    const fetchFn = mockFetch(quote(3.38, 1_800_000_000));
    const r = await ingestLive(env, { now: CLOSED, force: true, fetchFn });
    expect(r).toMatchObject({ status: "stored", isOutlier: false });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("https://api.twelvedata.com/quote?symbol=USD%2FPEN");
    expect(new Headers(init?.headers).get("authorization")).toMatch(/^apikey /);
    expect(
      await env.DB.prepare("SELECT ts, price, source, is_outlier FROM live_rates").first(),
    ).toEqual({
      ts: 1_800_000_000,
      price: 3.38,
      source: "twelvedata",
      is_outlier: 0,
    });
  });

  it("misma cotización dos veces → duplicate, sin fila nueva", async () => {
    quiet();
    const fetchFn = mockFetch(quote(3.38, 1_800_000_000), quote(3.38, 1_800_000_000));
    await ingestLive(env, { now: OPEN, fetchFn });
    expect((await ingestLive(env, { now: OPEN, fetchFn })).status).toBe("duplicate");
  });

  it("marca outlier (>1% de la mediana) sin borrar el dato", async () => {
    quiet();
    const seed = [3.4, 3.41, 3.39, 3.4, 3.405].map((p, i) =>
      env.DB.prepare("INSERT INTO live_rates (ts, price, source) VALUES (?, ?, 't')").bind(
        1000 + i,
        p,
      ),
    );
    await env.DB.batch(seed);
    const r = await ingestLive(env, { now: OPEN, fetchFn: mockFetch(quote(3.6, 2000)) });
    expect(r).toMatchObject({ status: "stored", isOutlier: true, median: 3.4 });
    const row = await env.DB.prepare("SELECT is_outlier FROM live_rates WHERE ts = 2000").first();
    expect(row).toEqual({ is_outlier: 1 });
  });

  it("cambio de nivel real: deja de marcar cuando las lecturas viejas salen de la ventana (2 h)", async () => {
    quiet();
    const t0 = 1_800_000_000;
    await env.DB.batch(
      [3.4, 3.41, 3.39, 3.4, 3.405].map((p, i) =>
        env.DB.prepare("INSERT INTO live_rates (ts, price, source) VALUES (?, ?, 't')").bind(
          t0 + i * 300,
          p,
        ),
      ),
    );
    // Salta a 3.6 y se queda ahí: al principio es outlier...
    const first = await ingestLive(env, { now: OPEN, fetchFn: mockFetch(quote(3.6, t0 + 1800)) });
    expect(first.isOutlier).toBe(true);
    // ...pero 2 h después del último dato válido ya no hay muestra vieja: arranque, no se marca.
    const later = await ingestLive(env, {
      now: OPEN,
      fetchFn: mockFetch(quote(3.6, t0 + 1200 + 7300)),
    });
    expect(later).toMatchObject({ status: "stored", isOutlier: false, median: null });
  });

  it("parseQuote exige last_quote_at (timestamp es el inicio de la vela diaria)", () => {
    expect(() => parseQuote({ close: "3.4", timestamp: 1 })).toThrow(/last_quote_at/);
  });

  it("429 de la API: un reintento y luego éxito", async () => {
    quiet();
    const fetchFn = mockFetch({ status: "error", code: 429, message: "límite" }, quote(3.38, 5));
    const r = await ingestLive(env, { now: OPEN, fetchFn, retryDelayMs: 0 });
    expect(r.status).toBe("stored");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("error no transitorio (401 de API) no se reintenta", async () => {
    quiet();
    const fetchFn = mockFetch({ status: "error", code: 401, message: "apikey" });
    await expect(ingestLive(env, { now: OPEN, fetchFn, retryDelayMs: 0 })).rejects.toThrow(/401/);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("respeta el límite local de créditos por minuto", async () => {
    quiet();
    const now = Date.now();
    for (let i = 0; i < CREDITS_PER_MINUTE; i++) await reserveCredit(env.DB, now);
    const fetchFn = mockFetch(quote(3.38, 7));
    await expect(ingestLive(env, { now: OPEN, force: true, fetchFn })).rejects.toThrow(/créditos/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("respeta el tope diario de créditos", async () => {
    quiet();
    const now = Math.floor(Date.now() / 1000);
    const stmts = Array.from({ length: CREDITS_PER_DAY }, (_, i) =>
      env.DB.prepare("INSERT INTO twelve_calls (ts) VALUES (?)").bind(now - 120 - i * 60),
    );
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    await expect(reserveCredit(env.DB, Date.now())).rejects.toThrow(/créditos/);
  });

  it("cada intento (incluido el reintento) queda registrado como crédito", async () => {
    quiet();
    const fetchFn = mockFetch({ status: "error", code: 429, message: "x" }, quote(3.38, 9));
    await ingestLive(env, { now: OPEN, fetchFn, retryDelayMs: 0 });
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM twelve_calls").first();
    expect(row).toEqual({ n: 2 });
  });
});

describe("runLiveCron", () => {
  it("no lanza si la API falla", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    await expect(runLiveCron(env, OPEN.getTime())).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("[live] falló"));
  });

  it("el scheduled handler despacha el cron de 5 min y omite con mercado cerrado", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await worker.scheduled(
      createScheduledController({ cron: CRON_LIVE, scheduledTime: CLOSED.getTime() }),
      env,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("[live] mercado cerrado, sin llamada");
  });
});

describe("cleanup", () => {
  it("borra lecturas de más de 90 días y conserva las recientes", async () => {
    quiet();
    const now = 1_800_000_000_000;
    const nowS = now / 1000;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO live_rates (ts, price, source) VALUES (?, 3.4, 't')").bind(
        nowS - 91 * 86_400,
      ),
      env.DB.prepare("INSERT INTO live_rates (ts, price, source) VALUES (?, 3.4, 't')").bind(
        nowS - 89 * 86_400,
      ),
    ]);
    await cleanup(env.DB, now);
    const { results } = await env.DB.prepare("SELECT ts FROM live_rates").all();
    expect(results).toEqual([{ ts: nowS - 89 * 86_400 }]);
  });
});
