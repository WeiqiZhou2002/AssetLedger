import { expect, it } from "vitest";
import { formatSyncTime } from "@/lib/bank-sync/time-format";
import { formatSpending, formatSpendingChange } from "@/lib/dashboard/presentation";

it("formats sync timestamps in the owner's local day, including midnight and year boundaries", () => {
  const now = new Date("2026-10-25T02:30:00Z");
  expect(formatSyncTime("2026-10-24T23:21:56.412Z", "America/Los_Angeles", now)).toBe("今天 16:21");
  expect(formatSyncTime("2026-10-24T02:05:00Z", "America/Los_Angeles", now)).toBe("昨天 19:05");
  expect(formatSyncTime("2026-10-21T15:30:00Z", "America/Los_Angeles", now)).toBe("10月21日 08:30");
  expect(formatSyncTime("2026-10-24T23:21:56.412Z", "Asia/Shanghai", now)).toBe("今天 07:21");
  expect(formatSyncTime("2025-12-31T17:00:00Z", "America/Los_Angeles", now)).toBe("2025年12月31日 09:00");
});
it("labels negative net spending as a positive net refund and retains comparison arithmetic", () => {
  expect(formatSpending("-120.25", "USD")).toBe("净退款 USD 120.25");
  expect(formatSpending("40", "USD")).toBe("USD 40.00");
  expect(formatSpendingChange("-120.25", "40", "USD")).toBe("较上月同期减少 USD 160.25");
  expect(formatSpendingChange("40", "-120.25", "USD")).toBe("较上月同期增加 USD 160.25");
  expect(formatSpendingChange("-20", "-20", "USD")).toBe("与上月同期持平");
});
