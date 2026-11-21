import { CRON_BCRP, CRON_LIVE } from "./crons";
import { handleAdminFetch } from "./admin";
import { bcrpHistory, bcrpLatest, health, liveHistory, liveLatest } from "./api";
import { runBcrpCron } from "./bcrp/ingest";
import { runLiveCron } from "./live/ingest";
import { json } from "./http";
import { handleMcp } from "./mcp";
import { dispatch, type Routes } from "./router";

const routes: Routes = {
  // SIMULACRO DE ROLLBACK (se revierte en el PR siguiente): rompe /api/health solo en
  // el host de producción, así CI pasa y el smoke test del deploy debe fallar y revertir.
  "/api/health": {
    GET: (_req, env, _ctx, url) =>
      url.hostname === "usd-monitor.gcs14.workers.dev"
        ? Response.json({ status: "broken-on-purpose" }, { status: 500 })
        : health(env),
  },
  "/api/live/latest": { GET: (_req, env) => liveLatest(env) },
  "/api/live": { GET: (_req, env, _ctx, url) => liveHistory(env, url) },
  "/api/bcrp/latest": { GET: (_req, env) => bcrpLatest(env) },
  "/api/bcrp": { GET: (_req, env, _ctx, url) => bcrpHistory(env, url) },
  "/admin/fetch": { POST: (req, env, _ctx, url) => handleAdminFetch(req, env, url) },
};

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      // MCP (Streamable HTTP, solo lectura): el handler gestiona sus métodos y CORS.
      if (new URL(request.url).pathname === "/mcp") return await handleMcp(request, env, ctx);
      const res = await dispatch(routes, request, env, ctx);
      return res ?? (await env.ASSETS.fetch(request));
    } catch (err) {
      // p. ej. D1 no disponible: JSON 503 en vez de la página de error 1101.
      console.error(
        `[http] ${new URL(request.url).pathname}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return json(
        { status: "error", error: "unavailable" },
        {
          status: 503,
          headers: {
            "cache-control": "no-store",
            // CORS solo en la API pública (no en /admin ni en los assets).
            ...(new URL(request.url).pathname.startsWith("/api/")
              ? { "access-control-allow-origin": "*" }
              : {}),
          },
        },
      );
    }
  },

  async scheduled(controller, env): Promise<void> {
    switch (controller.cron) {
      case CRON_LIVE:
        await runLiveCron(env, controller.scheduledTime);
        break;
      case CRON_BCRP:
        await runBcrpCron(env, new Date(controller.scheduledTime));
        break;
      default:
        console.warn(`[cron] expresión desconocida: ${controller.cron}`);
    }
  },
} satisfies ExportedHandler<Env>;
