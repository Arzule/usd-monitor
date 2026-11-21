import { json } from "./http";
import { dispatch, type Routes } from "./router";

const routes: Routes = {
  "/api/health": { GET: () => json({ status: "ok" }) },
};

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const res = await dispatch(routes, request, env, ctx);
    return res ?? env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
