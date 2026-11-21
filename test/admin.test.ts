import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAuthorized } from "../src/admin";

// ADMIN_TOKEN de prueba: lo inyecta vitest.config.ts (no es un secret real).
const TOKEN = "test-admin-token";
const URL_BCRP = "https://example.com/admin/fetch?source=bcrp";

function post(url: string, auth?: string) {
  return exports.default.fetch(url, {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  });
}

function firstUrl(spy: { mock: { calls: unknown[][] } }): string {
  const arg = spy.mock.calls[0]?.[0];
  if (arg instanceof Request) return arg.url;
  if (arg instanceof URL) return arg.href;
  return typeof arg === "string" ? arg : "";
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /admin/fetch", () => {
  it.each([
    ["sin header", undefined],
    ["token incorrecto", "Bearer otro-token"],
    ["prefijo del token", `Bearer ${TOKEN.slice(0, -1)}`],
    ["esquema distinto", `Basic ${TOKEN}`],
    ["Bearer vacío", "Bearer "],
  ])("%s → 401", async (_name, auth) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await post(URL_BCRP, auth);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(fetchSpy).not.toHaveBeenCalled(); // no se llama a ninguna API
  });

  it("GET → 405 (solo POST)", async () => {
    const res = await exports.default.fetch(URL_BCRP);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("HEAD en ruta solo-POST → 405 (HEAD solo aplica a rutas GET)", async () => {
    const res = await exports.default.fetch(URL_BCRP, { method: "HEAD" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("source inválido → 400", async () => {
    const res = await post("https://example.com/admin/fetch?source=nada", `Bearer ${TOKEN}`);
    expect(res.status).toBe(400);
  });

  it("token válido → ingesta BCRP y 200", async () => {
    await env.DB.exec("DELETE FROM bcrp_rates");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ periods: [{ name: "19.Nov.26", values: ["3.371", "3.375"] }] }),
            { status: 200 },
          ),
        ),
      );
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const res = await post(URL_BCRP, `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, source: "bcrp", result: { rows: 1 } });
    expect(firstUrl(fetchSpy)).toContain("estadisticas.bcrp.gob.pe");
    const row = await env.DB.prepare(
      "SELECT venta FROM bcrp_rates WHERE date = '2026-11-19'",
    ).first();
    expect(row).toEqual({ venta: 3.375 });
  });

  it("bcrp-backfill pide más de un año", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ periods: [] }), { status: 200 })),
      );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const res = await post(
      "https://example.com/admin/fetch?source=bcrp-backfill",
      `Bearer ${TOKEN}`,
    );
    expect(res.status).toBe(200);
    const m = /json\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(firstUrl(fetchSpy));
    const days = (Date.parse(m?.[2] ?? "") - Date.parse(m?.[1] ?? "")) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(366);
  });

  it("fallo del BCRP → 502 con mensaje, sin romper", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response("x", { status: 500 })),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await post(URL_BCRP, `Bearer ${TOKEN}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, error: "HTTP 500" });
  });
});

describe("isAuthorized", () => {
  const req = (auth: string) => new Request("https://x", { headers: { authorization: auth } });
  it("sin ADMIN_TOKEN configurado nadie pasa (falla cerrado)", async () => {
    expect(await isAuthorized(req("Bearer "), undefined)).toBe(false);
    expect(await isAuthorized(req("Bearer "), "")).toBe(false);
  });
  it("acepta el esquema sin distinguir mayúsculas", async () => {
    expect(await isAuthorized(req(`bearer ${TOKEN}`), TOKEN)).toBe(true);
  });
});
