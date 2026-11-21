import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

const URL_MCP = "https://usd-monitor.gcs14.workers.dev/mcp";
let id = 0;

/** Envía un mensaje JSON-RPC a /mcp y devuelve el resultado (acepta respuesta JSON o SSE). */
async function rpc(method: string, params: Record<string, unknown> = {}) {
  const res = await exports.default.fetch(URL_MCP, {
    method: "POST",
    headers: {
      // En producción Cloudflare siempre envía Host; en el test hay que ponerlo.
      host: "usd-monitor.gcs14.workers.dev",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  const json = res.headers.get("content-type")?.includes("text/event-stream")
    ? (JSON.parse(
        text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5))
          .join(""),
      ) as unknown)
    : (JSON.parse(text) as unknown);
  return {
    status: res.status,
    body: json as { result?: Record<string, unknown>; error?: unknown },
  };
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const { body } = await rpc("tools/call", { name, arguments: args });
  const result = body.result as { content: { text: string }[]; isError?: boolean } | undefined;
  const text = result?.content[0]?.text ?? "";
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* mensaje de error en texto plano */
  }
  return { isError: result?.isError ?? false, data: data as Record<string, unknown>, raw: body };
}

const now = () => Math.floor(Date.now() / 1000);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM live_rates"),
    env.DB.prepare("DELETE FROM bcrp_rates"),
  ]);
});

async function seed() {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO live_rates (ts, price, source, is_outlier) VALUES (?, 3.45, 't', 0)",
    ).bind(now() - 600),
    env.DB.prepare(
      "INSERT INTO live_rates (ts, price, source, is_outlier) VALUES (?, 3.9, 't', 1)",
    ).bind(now() - 300),
    env.DB.prepare("INSERT INTO bcrp_rates VALUES (?, 3.40, 3.41, 1)").bind(daysAgo(5)),
    env.DB.prepare("INSERT INTO bcrp_rates VALUES (?, 3.42, 3.43, 1)").bind(daysAgo(2)),
  ]);
}

describe("MCP /mcp", () => {
  it("rechaza un Host ajeno (protección contra DNS rebinding)", async () => {
    const res = await exports.default.fetch("https://evil.example/mcp", {
      method: "POST",
      headers: {
        host: "evil.example",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("initialize devuelve serverInfo y capacidad de tools", async () => {
    const { status, body } = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    expect(status).toBe(200);
    expect(body.result).toMatchObject({
      serverInfo: { name: "usd-monitor" },
      capabilities: { tools: {} },
    });
  });

  it("lista las 5 herramientas, todas de solo lectura y con descripción en español", async () => {
    const { body } = await rpc("tools/list");
    const tools = (
      body.result as {
        tools: { name: string; description: string; annotations?: { readOnlyHint?: boolean } }[];
      }
    ).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "compare_live_vs_official",
      "get_live_history",
      "get_live_rate",
      "get_official_history",
      "get_official_rate",
    ]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.description).toMatch(/tipo de cambio|USD\/PEN/i);
    }
  });

  it("get_live_rate: última lectura válida (ignora outliers)", async () => {
    await seed();
    const r = await callTool("get_live_rate");
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ price: 3.45 });
    expect(typeof r.data.market_open).toBe("boolean");
  });

  it("get_live_rate sin datos: price null y nota", async () => {
    const r = await callTool("get_live_rate");
    expect(r.data).toMatchObject({ price: null, note: expect.any(String) as string });
  });

  it("get_live_history valida el rango con Zod", async () => {
    await seed();
    const ok = await callTool("get_live_history", { range: "1d" });
    expect(ok.data).toMatchObject({ range: "1d", count: 1, min: 3.45, max: 3.45 });
    const bad = await callTool("get_live_history", { range: "10y" });
    expect(bad.isError).toBe(true);
  });

  it("get_official_rate: fecha exacta, día sin dato (anterior) y sin fecha", async () => {
    await seed();
    expect((await callTool("get_official_rate", { date: daysAgo(2) })).data).toMatchObject({
      venta: 3.43,
      exact: true,
    });
    expect((await callTool("get_official_rate", { date: daysAgo(3) })).data).toMatchObject({
      date: daysAgo(5),
      exact: false,
    });
    expect((await callTool("get_official_rate")).data).toMatchObject({ date: daysAgo(2) });
    for (const date of ["20.Nov.26", "2026-02-30"]) {
      expect((await callTool("get_official_rate", { date })).isError).toBe(true);
    }
  });

  it("get_official_history: rango válido, invertido y demasiado largo", async () => {
    await seed();
    expect(
      (await callTool("get_official_history", { from: daysAgo(10), to: daysAgo(0) })).data,
    ).toMatchObject({
      count: 2,
    });
    expect(
      (await callTool("get_official_history", { from: daysAgo(0), to: daysAgo(10) })).isError,
    ).toBe(true);
    expect(
      (await callTool("get_official_history", { from: "2020-01-01", to: daysAgo(0) })).isError,
    ).toBe(true);
    // Borde: 400 días inclusivos pasan, 401 no.
    expect(
      (await callTool("get_official_history", { from: daysAgo(399), to: daysAgo(0) })).isError,
    ).toBe(false);
    expect(
      (await callTool("get_official_history", { from: daysAgo(400), to: daysAgo(0) })).isError,
    ).toBe(true);
  });

  it("compare_live_vs_official: diferencias contra compra y venta", async () => {
    await seed();
    const r = await callTool("compare_live_vs_official");
    expect(r.data).toMatchObject({
      live: { price: 3.45 },
      official: { date: daysAgo(2) },
      vs_venta: { abs: 0.02 },
    });
    expect(r.data.explanation).toMatch(/por encima del tipo de cambio oficial de venta del BCRP/);
    const pct = (r.data.vs_venta as { pct: number }).pct;
    expect(pct).toBeCloseTo((0.02 / 3.43) * 100, 3);
  });

  it("compare_live_vs_official sin datos → isError", async () => {
    expect((await callTool("compare_live_vs_official")).isError).toBe(true);
  });
});
