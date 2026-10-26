import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";
// Common Drizzle contract accepted by node-postgres, PGlite, and transactions.
export type AppDb = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();
