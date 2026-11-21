// Secrets del Worker: se suben en deploy.yml (wrangler deploy --secrets-file),
// nunca en wrangler.toml, así que `wrangler types` no los conoce. Opcionales a
// propósito: el código debe fallar cerrado si faltan.
interface Env {
  ADMIN_TOKEN?: string;
  TWELVE_DATA_API_KEY?: string;
}
