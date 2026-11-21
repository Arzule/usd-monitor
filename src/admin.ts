import { BCRP_BACKFILL_DAYS, BCRP_RECENT_DAYS, ingestBcrp } from "./bcrp/ingest";
import { json } from "./http";
import { CreditLimitError, ingestLive } from "./live/ingest";

const encoder = new TextEncoder();

/**
 * Compara el Bearer token con ADMIN_TOKEN en tiempo constante: se comparan los
 * SHA-256 de ambos (misma longitud) con crypto.subtle.timingSafeEqual.
 * Sin ADMIN_TOKEN configurado, nadie está autorizado (falla cerrado).
 */
export async function isAuthorized(request: Request, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const match = /^Bearer[ ]+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  const provided = match?.[1] ?? "";
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(token)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b) && provided !== "";
}

export const ADMIN_SOURCES = ["live", "bcrp", "bcrp-backfill"] as const;
export type AdminSource = (typeof ADMIN_SOURCES)[number];

function isAdminSource(s: string | null): s is AdminSource {
  return s !== null && (ADMIN_SOURCES as readonly string[]).includes(s);
}

/** POST /admin/fetch?source=... — lectura forzada. No se expone en dashboard ni MCP. */
export async function handleAdminFetch(request: Request, env: Env, url: URL): Promise<Response> {
  if (!(await isAuthorized(request, env.ADMIN_TOKEN))) {
    return json(
      { error: "unauthorized" },
      { status: 401, headers: { "www-authenticate": 'Bearer realm="admin"' } },
    );
  }
  const source = url.searchParams.get("source");
  if (!isAdminSource(source)) {
    return json({ error: "invalid_source", allowed: ADMIN_SOURCES }, { status: 400 });
  }

  try {
    if (source === "live") {
      // Lectura forzada: ignora el horario de mercado, respeta los créditos/min.
      const result = await ingestLive(env, { force: true });
      console.log(`[admin] live: ${result.status}`);
      return json({ ok: true, source, result });
    }
    const days = source === "bcrp-backfill" ? BCRP_BACKFILL_DAYS : BCRP_RECENT_DAYS;
    const result = await ingestBcrp(env, days);
    console.log(`[admin] ${source}: ${String(result.rows)} fechas ${result.from}..${result.to}`);
    return json({ ok: true, source, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof CreditLimitError) {
      return json(
        { ok: false, source, error: message },
        { status: 429, headers: { "retry-after": "60" } },
      );
    }
    console.error(`[admin] ${source} falló: ${message}`);
    return json({ ok: false, source, error: message }, { status: 502 });
  }
}
