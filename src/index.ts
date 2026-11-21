import { handleAdminFetch } from "./admin";
import { runBcrpCron } from "./bcrp/ingest";
import { json } from "./http";
import { runLiveCron } from "./live/ingest";
import { dispatch, type Routes } from "./router";

/** Deben coincidir con [triggers].crons en wrangler.toml (lo verifica un test). */
export const CRON_LIVE = "*/5 * * * *";
export const CRON_BCRP = "0 * * * MON-FRI";

const routes: Routes = {
  "/api/health": { GET: () => json({ status: "ok" }) },
  "/admin/fetch": { POST: (req, env, _ctx, url) => handleAdminFetch(req, env, url) },
};

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const res = await dispatch(routes, request, env, ctx);
    return res ?? env.ASSETS.fetch(request);
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
