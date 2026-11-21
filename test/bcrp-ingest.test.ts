import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bcrpUrl, ingestBcrp, runBcrpCron, upsertBcrpRows } from "../src/bcrp/ingest";
import { fetchJson } from "../src/fetch-json";

function bcrpBody(periods: [string, string, string][]) {
  return { config: {}, periods: periods.map(([name, c, v]) => ({ name, values: [c, v] })) };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function allRows() {
  const { results } = await env.DB.prepare(
    "SELECT date, compra, venta, fetched_at FROM bcrp_rates ORDER BY date",
  ).all();
  return results;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM bcrp_rates");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ingestBcrp", () => {
  it("pide el rango en fechas de Lima y hace upsert", async () => {
    // 2026-11-21 03:00 UTC = 2026-11-20 22:00 en Lima
    const now = new Date("2026-11-21T03:00:00Z");
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        jsonResponse(
          bcrpBody([
            ["19.Nov.26", "3.371", "3.375"],
            ["20.Nov.26", "n.d.", "n.d."],
          ]),
        ),
      ),
    );

    const r = await ingestBcrp(env, 10, now, fetchFn);

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]?.[0]).toBe(bcrpUrl("2026-11-10", "2026-11-20"));
    expect(r).toEqual({ from: "2026-11-10", to: "2026-11-20", rows: 1, latest: "2026-11-19" });
    expect(await allRows()).toEqual([
      { date: "2026-11-19", compra: 3.371, venta: 3.375, fetched_at: 1795230000 },
    ]);
  });

  it("es idempotente y un n.d. posterior no pisa un valor guardado", async () => {
    await upsertBcrpRows(env.DB, [{ date: "2026-11-19", compra: 3.37, venta: 3.38 }], 100);
    await upsertBcrpRows(env.DB, [{ date: "2026-11-19", compra: null, venta: 3.39 }], 200);
    expect(await allRows()).toEqual([
      { date: "2026-11-19", compra: 3.37, venta: 3.39, fetched_at: 200 },
    ]);
  });

  it("parte el backfill en sentencias de ≤25 filas (límite de parámetros de D1)", async () => {
    const rows = Array.from({ length: 280 }, (_, i) => {
      const d = new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      return { date: d, compra: 3 + i / 1000, venta: 3.1 + i / 1000 };
    });
    expect(await upsertBcrpRows(env.DB, rows, 1)).toBe(280);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM bcrp_rates").first<{
      n: number;
    }>();
    expect(count?.n).toBe(280);
  });

  it("reintenta una vez ante un 503 y luego tiene éxito", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("caído", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(bcrpBody([["19.Nov.26", "3.371", "3.375"]])));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const body = await fetchJson("https://x.test", {}, { label: "t", fetchFn, retryDelayMs: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(body).toMatchObject({ periods: [{ name: "19.Nov.26" }] });
  });

  it("reintenta una vez ante un 429", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => Promise.resolve(new Response("", { status: 429 })))
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({ ok: 1 })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      fetchJson("https://x.test", {}, { label: "t", fetchFn, retryDelayMs: 0 }),
    ).resolves.toEqual({ ok: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("timeout cuenta como fallo transitorio (con reintento)", async () => {
    const fetchFn = vi.fn<typeof fetch>((_url, init) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(signal.reason as Error);
        });
      });
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      fetchJson("https://x.test", {}, { label: "t", fetchFn, retryDelayMs: 0, timeoutMs: 20 }),
    ).rejects.toThrow("timeout");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("no reintenta un 404", async () => {
    const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(new Response("no", { status: 404 })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      fetchJson("https://x.test", {}, { label: "t", fetchFn, retryDelayMs: 0 }),
    ).rejects.toThrow("HTTP 404");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("respuesta vacía o JSON inválido cuentan como fallo (con reintento)", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      fetchJson("https://x.test", {}, { label: "t", fetchFn, retryDelayMs: 0 }),
    ).rejects.toThrow("JSON inválido");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("runBcrpCron", () => {
  it("no lanza si el BCRP falla y deja un log de error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(runBcrpCron(env)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("[bcrp] falló la ingesta"));
  });
});
