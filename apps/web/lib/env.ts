import { z } from "zod";
const schema = z.object({
  APP_SECRET: z.string().min(32),
  APP_URL: z
    .url()
    .default("http://localhost:3000")
    .refine((v) => ["http:", "https:"].includes(new URL(v).protocol)),
  EXTRA_ALLOWED_ORIGINS: z
    .string()
    .default("")
    .refine((value) => {
      return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .every((item) => {
          try {
            const url = new URL(item);
            return (
              ["http:", "https:"].includes(url.protocol) &&
              !url.username &&
              !url.password &&
              url.pathname === "/" &&
              !url.search &&
              !url.hash
            );
          } catch {
            return false;
          }
        });
    }),
  DATA_DIR: z.string().min(1).default("./data"),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(20),
  MAX_PDF_PAGES: z.coerce.number().int().min(1).max(500).default(60),
  FILE_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(30),
  PLAID_ENABLED: z.enum(["true", "false"]).default("false"),
  PLAID_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  PLAID_CLIENT_ID: z.string().default(""),
  PLAID_SECRET: z.string().default(""),
  PLAID_REDIRECT_URI: z.string().default(""),
  PLAID_SYNC_INTERVAL_HOURS: z.coerce.number().min(1).max(168).default(12),
  PLAID_DAYS_REQUESTED: z.coerce.number().int().min(1).max(730).default(90),
  PLAID_HISTORY_START: z.union([z.iso.date(), z.literal("")]).default(""),
  AI_PARSING_ENABLED: z.enum(["true", "false"]).default("false"),
  ANTHROPIC_API_KEY: z.string().default(""),
  AI_MODEL: z.string().default(""),
  FX_STALE_DAYS: z.coerce.number().int().min(0).max(3650).default(7),
  STALE_ACCOUNT_DAYS: z.coerce.number().int().min(0).max(3650).default(14),
  DATABASE_URL: z.string().min(1),
  BASE_CURRENCY: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default("USD"),
  TZ: z.string().default("America/Los_Angeles"),
  PARSER_URL: z.union([z.url(), z.literal("")]).default(""),
  TRUST_CLOUDFLARE_HEADERS: z.enum(["true", "false"]).default("false"),
});
export function readEnv() {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    // Only names, never values (DATABASE_URL and APP_SECRET contain credentials).
    throw new Error(`环境变量无效：${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  }
  if (result.data.PLAID_REDIRECT_URI) {
    let valid = false;
    try {
      const url = new URL(result.data.PLAID_REDIRECT_URI);
      valid =
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password &&
        (url.protocol === "https:" ||
          (result.data.PLAID_ENV === "sandbox" && url.protocol === "http:" && url.hostname === "localhost"));
    } catch {
      /* Report only the key. */
    }
    if (!valid) throw new Error("环境变量无效：PLAID_REDIRECT_URI");
  }
  return result.data;
}
