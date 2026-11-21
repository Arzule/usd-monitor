import { handleAdminFetch } from "./admin";
import { bcrpHistory, bcrpLatest, health, liveHistory, liveLatest } from "./api";
import { runBcrpCron } from "./bcrp/ingest";
import { runLiveCron } from "./live/ingest";
import { json } from "./http";
import { dispatch, type Routes } from "./router";

/** Deben coincidir con [triggers].crons en wrangler.toml (lo verifica un test). */
export const CRON_LIVE = "*/5 * * * *";
export const CRON_BCRP = "0 * * * MON-FRI";

const routes: Routes = {
  "/api/health": { GET: (_req, env) => health(env) },
  "/api/live/latest": { GET: (_req, env) => liveLatest(env) },
  "/api/live": { GET: (_req, env, _ctx, url) => liveHistory(env, url) },
  "/api/bcrp/latest": { GET: (_req, env) => bcrpLatest(env) },
  "/api/bcrp": { GET: (_req, env, _ctx, url) => bcrpHistory(env, url) },
  "/admin/fetch": { POST: (req, env, _ctx, url) => handleAdminFetch(req, env, url) },
};

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
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
          headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
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
