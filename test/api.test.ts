import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BASE = "https://example.com";
const get = (path: string, init?: RequestInit) => exports.default.fetch(`${BASE}${path}`, init);
const now = () => Math.floor(Date.now() / 1000);

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM live_rates"),
    env.DB.prepare("DELETE FROM bcrp_rates"),
  ]);
});

async function seedLive(rows: [number, number, number][]) {
  await env.DB.batch(
    rows.map(([ts, price, o]) =>
      env.DB.prepare(
        "INSERT INTO live_rates (ts, price, source, is_outlier) VALUES (?, ?, 't', ?)",
      ).bind(ts, price, o),
    ),
  );
}

describe("API vacía (estado inicial)", () => {
  it("health, latest e historiales responden 200 con datos vacíos", async () => {
    const h = await get("/api/health");
    expect(h.status).toBe(200);
    expect(await h.json()).toMatchObject({ status: "ok", last_live: null, last_bcrp_date: null });
    expect(await (await get("/api/live/latest")).json()).toEqual({ data: null });
    expect(await (await get("/api/bcrp/latest")).json()).toEqual({ data: null });
    expect(await (await get("/api/live?range=1d")).json()).toMatchObject({ count: 0, data: [] });
    expect(await (await get("/api/bcrp?range=1m")).json()).toMatchObject({ count: 0, data: [] });
  });
});

describe("GET /api/health", () => {
  it("incluye última lectura, última fecha BCRP y estado del mercado", async () => {
    await seedLive([[now() - 60, 3.44, 0]]);
    await env.DB.prepare("INSERT INTO bcrp_rates VALUES ('2026-11-19', 3.4, 3.41, 1)").run();
    const body = await (await get("/api/health")).json<Record<string, unknown>>();
    expect(body).toMatchObject({
      last_live: { price: 3.44, is_outlier: false },
      last_bcrp_date: "2026-11-19",
    });
    expect(typeof body.market_open).toBe("boolean");
    expect(typeof body.lima_session_open).toBe("boolean");
  });
});

describe("GET /api/live", () => {
  it("latest ignora outliers", async () => {
    await seedLive([
      [now() - 600, 3.44, 0],
      [now() - 300, 3.9, 1],
    ]);
    expect(await (await get("/api/live/latest")).json()).toMatchObject({ data: { price: 3.44 } });
  });

  it("excluye outliers por defecto y los devuelve aparte con include_outliers=true", async () => {
    await seedLive([
      [now() - 900, 3.44, 0],
      [now() - 600, 3.9, 1],
      [now() - 300, 3.45, 0],
      [now() - 3 * 86_400, 3.3, 0], // fuera de 1d
    ]);
    const def = await (await get("/api/live?range=1d")).json<{ data: { price: number }[] }>();
    expect(def.data.map((d) => d.price)).toEqual([3.44, 3.45]);
    expect(def).not.toHaveProperty("outliers");
    const inc = await (await get("/api/live?range=1d&include_outliers=true")).json();
    expect(inc).toMatchObject({
      include_outliers: true,
      outliers: [{ price: 3.9, is_outlier: true }],
    });
    const five = await (await get("/api/live?range=5d")).json<{ count: number }>();
    expect(five.count).toBe(3);
  });

  it("1m agrupa por hora", async () => {
    const h = Math.floor(now() / 3600) * 3600 - 7200;
    await seedLive([
      [h + 60, 3.4, 0],
      [h + 120, 3.5, 0],
      [h + 3700, 3.6, 0],
    ]);
    const body = await (
      await get("/api/live?range=1m")
    ).json<{ bucket_seconds: number; data: { price: number }[] }>();
    expect(body.bucket_seconds).toBe(3600);
    expect(body.data.map((d) => d.price)).toEqual([3.45, 3.6]);
  });

  it.each(["/api/live?range=2y", "/api/live?include_outliers=si", "/api/bcrp?range=5d"])(
    "%s → 400 con valores permitidos",
    async (path) => {
      const res = await get(path);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_parameter" });
      expect(res.headers.get("cache-control")).toBe("no-store");
    },
  );
});

describe("GET /api/bcrp", () => {
  it("latest y rango 1y, ordenados por fecha, con n.d. como null", async () => {
    const d = (daysAgo: number) =>
      new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO bcrp_rates VALUES (?, 3.4, 3.41, 1)").bind(d(3)),
      env.DB.prepare("INSERT INTO bcrp_rates VALUES (?, NULL, 3.42, 1)").bind(d(2)),
      env.DB.prepare("INSERT INTO bcrp_rates VALUES (?, 3.3, 3.31, 1)").bind(d(200)),
      env.DB.prepare("INSERT INTO bcrp_rates VALUES (?, 3.2, 3.21, 1)").bind(d(400)),
    ]);
    expect(await (await get("/api/bcrp/latest")).json()).toEqual({
      data: { date: d(2), compra: null, venta: 3.42 },
    });
    const m = await (await get("/api/bcrp?range=1m")).json<{ count: number }>();
    expect(m.count).toBe(2);
    const y = await (await get("/api/bcrp?range=1y")).json<{ data: { date: string }[] }>();
    expect(y.data.map((r) => r.date)).toEqual([d(200), d(3), d(2)]);
  });
});

describe("errores", () => {
  it("fallo de D1 → 503 JSON con no-store y CORS (no la página 1101)", async () => {
    vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("D1_ERROR");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await get("/api/health");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "error", error: "unavailable" });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("market_open refleja el horario real", async () => {
    const { health } = await import("../src/api");
    const sat = await (await health(env, new Date("2026-11-21T15:00:00Z"))).json();
    const mon = await (await health(env, new Date("2026-11-23T15:00:00Z"))).json();
    expect(sat).toMatchObject({ market_open: false });
    expect(mon).toMatchObject({ market_open: true, lima_session_open: true });
  });
});

describe("CORS y cache", () => {
  it("GET: CORS abierto y cache corto", async () => {
    const res = await get("/api/live/latest");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("preflight OPTIONS solo permite métodos de lectura", async () => {
    const res = await get("/api/live", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
  });

  it("POST a la API → 405, y /admin no expone CORS", async () => {
    expect((await get("/api/live", { method: "POST" })).status).toBe(405);
    const admin = await get("/admin/fetch", { method: "OPTIONS" });
    expect(admin.status).toBe(405);
    expect(admin.headers.get("access-control-allow-origin")).toBeNull();
  });
});
