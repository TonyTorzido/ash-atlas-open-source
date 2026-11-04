import pg from "pg";

import { loadConfig } from "../config.js";
import { validateItemDefinitionCatalog } from "../game/items.js";

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });

try {
  await validateItemDefinitionCatalog(pool);
  process.stdout.write('{"ok":true,"catalog":"compiled-and-migrated"}\n');
} finally {
  await pool.end();
}
