import type { getStatementReview, listStatements } from "@/lib/imports/service";
import type { aiPreview } from "@/lib/imports/ai";
export type Review = Awaited<ReturnType<typeof getStatementReview>>;
export type ImportRow = Review["rows"][number];
export type StatementList = Awaited<ReturnType<typeof listStatements>>;
export type AiPreview = Awaited<ReturnType<typeof aiPreview>>;
export const statusLabels: Record<string, string> = {
  uploaded: "已上传",
  queued: "排队中",
  parsing: "识别中",
  needs_mapping: "待匹配",
  needs_review: "待审核",
  approved: "已完成",
  failed: "处理失败",
  discarded: "已丢弃",
};
