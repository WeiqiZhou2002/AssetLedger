import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
const parse = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {}
  class RateLimitError extends APIError {}
  class Client {
    static APIError = APIError;
    static RateLimitError = RateLimitError;
    beta = { messages: { parse } };
  }
  return { default: Client };
});
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { importRows, statements, auditLogs } from "@/db/schema";
import { aiPreview, consentToAi, callAi, applyAiRows } from "@/lib/imports/ai";
import { sha256 } from "@/lib/imports/text";
import type { AiConsent } from "@/lib/imports/types";
let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
let id: string;
const config = { AI_PARSING_ENABLED: "true", ANTHROPIC_API_KEY: "synthetic-not-a-secret", AI_MODEL: "" };
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.client.close();
});
beforeEach(async () => {
  parse.mockReset();
  await h.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(h.db);
  const [statement] = await h.db
    .insert(statements)
    .values({
      ownerId: f.ownerId,
      accountId: f.card.id,
      fileSha256: sha256("synthetic"),
      originalFilename: "synthetic.pdf",
      mime: "application/pdf",
      sizeBytes: 10,
      status: "needs_review",
      transactionLines: [{ page: 2, text: "10/12 EXAMPLE CAFE 1234567890 $12.00" }],
      diagnostics: [{ kind: "unrecognized_transaction_line", count: 1, severity: "warning" }],
    })
    .returning();
  id = statement.id;
});
it("is disabled by default and requires matching explicit per-statement consent", async () => {
  expect((await aiPreview(h.db, f.ownerId, id, { ...config, AI_PARSING_ENABLED: "false" })).available).toBe(
    false,
  );
  await expect(callAi(null, config)).rejects.toMatchObject({ kind: "ai_consent_required" });
  await expect(
    consentToAi(h.db, f.ownerId, id, { confirmed: false, inputHash: sha256("anything") }, config),
  ).rejects.toThrow();
  const preview = await aiPreview(h.db, f.ownerId, id, config);
  expect(preview.lines[0].text).toContain("******7890");
  expect(preview.model).toBe("claude-opus-5-5");
  await expect(
    consentToAi(h.db, f.otherId, id, { confirmed: true, inputHash: preview.inputHash }, config),
  ).rejects.toThrow("账单不存在");
  await expect(
    consentToAi(h.db, f.ownerId, id, { confirmed: true, inputHash: sha256("changed") }, config),
  ).rejects.toThrow("预览内容已变化");
  const job = await consentToAi(
    h.db,
    f.ownerId,
    id,
    { confirmed: true, inputHash: preview.inputHash },
    config,
  );
  expect(job.consent?.lines).toEqual(preview.lines);
  expect((await h.db.select().from(auditLogs)).some((row) => row.action === "statement.ai_consent")).toBe(
    true,
  );
  expect(parse).not.toHaveBeenCalled();
});
it("sends only confirmed masked lines with typed fallback, caps confidence and requires review", async () => {
  const preview = await aiPreview(h.db, f.ownerId, id, config);
  const job = await consentToAi(
    h.db,
    f.ownerId,
    id,
    { confirmed: true, inputHash: preview.inputHash },
    config,
  );
  parse.mockResolvedValue({
    stop_reason: "end_turn",
    parsed_output: {
      rows: [
        {
          transaction_date: "2026-10-12",
          posted_date: "2026-10-12",
          description_raw: "EXAMPLE CAFE",
          merchant_normalized: "EXAMPLE CAFE",
          amount_raw: "$12.00",
          amount: "-12.00",
          currency: "USD",
          direction: "charge",
          source_page: 2,
          source_row_text: preview.lines[0].text,
          provider_transaction_id: null,
        },
      ],
    },
  });
  const rows = await callAi(job.consent, config);
  expect(rows[0].confidence).toBe("0.600");
  const sent = parse.mock.calls[0][0];
  expect(sent.messages[0].content).toBe(JSON.stringify(preview.lines));
  expect(sent.output_config.effort).toBe("medium");
  expect(sent.betas).toContain("server-side-fallback-2026-07-01");
  expect(sent.fallbacks).toBe("default");
  expect(sent.thinking).toBeUndefined();
  expect(sent.temperature).toBeUndefined();
  await applyAiRows(h.db, f.ownerId, id, job.consent!, rows);
  const [stored] = await h.db.select().from(importRows);
  expect(stored.source).toBe("ai");
  expect(stored.decision).toBe("pending");
  expect(stored.journalEntryId).toBeNull();
});
it.each([
  ["refusal", "ai_refusal"],
  ["max_tokens", "ai_max_tokens"],
  ["end_turn", "ai_invalid_output"],
])("rejects %s without importing", async (stop, kind) => {
  const preview = await aiPreview(h.db, f.ownerId, id, config);
  const consent: AiConsent = { ...preview, confirmedAt: new Date().toISOString() };
  parse.mockResolvedValue({ stop_reason: stop, parsed_output: null });
  await expect(callAi(consent, config)).rejects.toMatchObject({ kind });
  expect(await h.db.select().from(importRows)).toHaveLength(0);
});
