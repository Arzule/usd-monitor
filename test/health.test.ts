import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("routing", () => {
  it("GET /api/health responde 200 con JSON", async () => {
    const res = await exports.default.fetch("https://example.com/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("rutas /api desconocidas responden 404 JSON", async () => {
    const res = await exports.default.fetch("https://example.com/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
