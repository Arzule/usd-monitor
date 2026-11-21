import { json } from "./http";

export type Handler = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
) => Response | Promise<Response>;

export type Routes = Record<string, Partial<Record<"GET" | "POST", Handler>>>;

/** Prefijos que siempre maneja el Worker (nunca caen a los assets estáticos). */
const WORKER_PREFIXES = ["/api/", "/admin/", "/mcp/"];
const WORKER_EXACT = ["/mcp"];

export function isWorkerPath(pathname: string): boolean {
  return WORKER_EXACT.includes(pathname) || WORKER_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Despacha una petición a la tabla de rutas.
 * - HEAD usa el handler GET y descarta el cuerpo.
 * - Ruta conocida con método no soportado → 405 + `Allow`.
 * - Ruta de Worker desconocida → 404 JSON. Devuelve `null` si no es ruta del Worker.
 */
export async function dispatch(
  routes: Routes,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  const route = routes[url.pathname];

  if (route) {
    const method = request.method.toUpperCase();
    if (method === "HEAD" && route.GET) {
      const res = await route.GET(request, env, ctx, url);
      return new Response(null, { status: res.status, headers: res.headers });
    }
    const handler = method === "GET" || method === "POST" ? route[method] : undefined;
    if (handler) return handler(request, env, ctx, url);

    const allow = Object.keys(route);
    if (route.GET) allow.push("HEAD");
    return json(
      { error: "method_not_allowed" },
      { status: 405, headers: { allow: allow.join(", ") } },
    );
  }

  if (isWorkerPath(url.pathname)) return json({ error: "not_found" }, { status: 404 });
  return null;
}
