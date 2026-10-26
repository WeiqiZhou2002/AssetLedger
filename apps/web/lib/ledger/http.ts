import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import type { AppDb } from "@/db/types";
import { authenticated, HttpError, json, mutation, readJson } from "@/lib/auth/http";
import { ImportFailure } from "@/lib/imports/parser";
import { ApprovalError } from "@/lib/imports/readiness";
import { LedgerError } from "./errors";
export type LedgerContext = { db: AppDb; ownerId: string; id?: string };
function databaseCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  return "cause" in error ? databaseCode(error.cause) : undefined;
}
export function ledgerRoute(
  handler: (request: NextRequest, context: LedgerContext) => Promise<unknown>,
  mutating = false,
) {
  return async (request: NextRequest, context?: { params: Promise<{ id?: string }> }) => {
    const run = async () => {
      try {
        const { user } = await authenticated(request);
        const params = context ? await context.params : undefined;
        const id = params?.id ? z.uuid().parse(params.id) : undefined;
        const result = await handler(request, { db: getDb(), ownerId: user.id, id });
        return result instanceof NextResponse ? result : json(result);
      } catch (error) {
        if (error instanceof ApprovalError)
          return json({ error: error.message, rowErrors: error.rowErrors }, 400);
        if (error instanceof ImportFailure)
          return json(
            {
              error:
                error.kind === "needs_password"
                  ? "PDF 需要正确密码，请在上传时填写"
                  : "文件处理失败，请检查文件或解析服务",
              errorKind: error.kind,
            },
            error.kind === "needs_password" ? 422 : 400,
          );
        if (error instanceof LedgerError || error instanceof HttpError)
          return json({ error: error.message }, error.status);
        if (error instanceof z.ZodError || error instanceof SyntaxError)
          return json({ error: "输入格式无效，请检查日期、金额和必填项" }, 400);
        const code = databaseCode(error);
        if (code === "23505") return json({ error: "名称或记录已存在，请勿重复创建" }, 409);
        if (code === "23503" || code === "23514" || code === "22003")
          return json({ error: "数据关系或金额范围无效，请检查输入" }, 400);
        console.error(JSON.stringify({ kind: "ledger_request_failed" }));
        return json({ error: "暂时无法完成，请稍后重试" }, 503);
      }
    };
    return mutating ? mutation(run)(request) : run();
  };
}
export function ledgerBody(request: Request) {
  return readJson(request, 65536);
}
