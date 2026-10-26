import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { todayInTimezone } from "@/lib/ledger/format";
let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
vi.mock("@/db/client", () => ({ getDb: () => h.db }));
vi.mock("@/lib/auth/current-user", () => ({
  requireUser: async () => ({ id: f.ownerId, timezone: "UTC", baseCurrency: "USD" }),
}));
const { default: Dashboard } = await import("@/app/(app)/dashboard/page");
const { default: Details } = await import("@/app/(app)/dashboard/details/page");
beforeAll(async () => {
  h = await createTestDb();
  f = await ledgerFixture(h.db);
  vi.stubEnv("APP_SECRET", "synthetic-dashboard-page-secret-32-characters");
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic/test");
});
afterAll(async () => {
  await h.client.close();
  vi.unstubAllEnvs();
});
it("ignores month on the overview while details retain their requested month and picker", async () => {
  const current = todayInTimezone("UTC").slice(0, 7);
  const searchParams = Promise.resolve({ month: "2026-01", view: "spending", basis: "event" });
  const overview = await Dashboard({ searchParams });
  expect(overview.props.month.month).toBe(current);
  expect(overview.props.month.basis).toBe("event");
  const html = renderToStaticMarkup(overview);
  expect(html).not.toContain('aria-label="统计月份"');
  expect(html).toContain(`month=${current}`);
  expect(html).toContain("本月支出");
  const details = await Details({ searchParams });
  expect(details.props.month.month).toBe("2026-01");
  const detailHtml = renderToStaticMarkup(details);
  expect(detailHtml).toContain('aria-label="统计月份"');
  expect(detailHtml).toContain("2026-01");
});
