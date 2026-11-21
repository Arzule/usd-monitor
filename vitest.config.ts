import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // Las migraciones se leen en Node y se aplican dentro del runtime de Workers
  // (test/apply-migrations.ts) sobre la D1 local y aislada de los tests.
  const migrations = await readD1Migrations("./migrations");

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // ADMIN_TOKEN de prueba (no es un secret real); TEST_MIGRATIONS para la D1 de test.
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_TOKEN: "test-admin-token",
            TWELVE_DATA_API_KEY: "test-twelve-key",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
