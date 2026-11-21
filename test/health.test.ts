import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://example.com";

describe("routing", () => {
  it("GET /api/health responde 200 con JSON", async () => {
    const res = await exports.default.fetch(`${BASE}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("HEAD /api/health responde 200 sin cuerpo", async () => {
    const res = await exports.default.fetch(`${BASE}/api/health`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("método no soportado en ruta conocida → 405 con Allow", async () => {
    const res = await exports.default.fetch(`${BASE}/api/health`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    expect(await res.json()).toEqual({ error: "method_not_allowed" });
  });

  it.each(["/api/nope", "/admin/nope", "/mcp/x"])(
    "%s desconocida responde 404 JSON (no la página HTML)",
    async (path) => {
      const res = await exports.default.fetch(`${BASE}${path}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "not_found" });
    },
  );

  it("GET / sirve el dashboard desde los assets", async () => {
    const res = await exports.default.fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>USD/PEN Monitor</title>");
  });
});

describe("migraciones D1", () => {
  it("crean live_rates y bcrp_rates", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('live_rates', 'bcrp_rates') ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["bcrp_rates", "live_rates"]);
  });

  it("bcrp_rates acepta compra/venta NULL (n.d.) e is_outlier vale 0 por defecto", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO bcrp_rates (date, compra, venta, fetched_at) VALUES ('2026-11-20', NULL, 3.4, 1)",
      ),
      env.DB.prepare("INSERT INTO live_rates (ts, price, source) VALUES (1, 3.4, 'test')"),
    ]);
    const row = await env.DB.prepare("SELECT is_outlier FROM live_rates WHERE ts = 1").first<{
      is_outlier: number;
    }>();
    expect(row?.is_outlier).toBe(0);
  });
});
