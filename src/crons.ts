// Expresiones de Cron Triggers. Viven fuera de src/index.ts porque el módulo
// principal de un Worker solo puede exportar handlers (workerd rechaza otras exportaciones).
// Deben coincidir con [triggers].crons en wrangler.toml (lo verifica un test).
export const CRON_LIVE = "*/5 * * * *";
export const CRON_BCRP = "0 * * * MON-FRI";
