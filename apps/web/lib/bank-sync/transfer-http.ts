import type { NextRequest } from "next/server";
import { HttpError, json } from "@/lib/auth/http";
import { RateLimitError } from "@/lib/auth/rate-limit";
import { MAX_TRANSFER_BYTES } from "./transfer-bundle";
export async function transferRequest<T>(run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof RateLimitError)) throw error;
    const response = json({ error: error.message }, 429);
    response.headers.set("Retry-After", "900");
    return response;
  }
}
export async function readTransferForm(request: NextRequest) {
  const contentType = request.headers.get("content-type");
  if (!contentType?.startsWith("multipart/form-data")) throw new HttpError(415, "请选择连接文件");
  // Bound the stream before multipart parsing, even without an honest Content-Length.
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "请求内容为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_TRANSFER_BYTES + 16384) {
      await reader.cancel();
      throw new HttpError(413, "连接文件不能超过 256 KB");
    }
    chunks.push(value);
  }
  let form: FormData;
  try {
    form = await new Response(Buffer.concat(chunks), { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new HttpError(400, "连接文件格式无效");
  }
  const file = form.get("file");
  if (!file || typeof file === "string") throw new HttpError(400, "请选择连接文件");
  if (file.size > MAX_TRANSFER_BYTES) throw new HttpError(413, "连接文件不能超过 256 KB");
  return {
    file: await file.text(),
    credentials: {
      passphrase: form.get("passphrase"),
      ...(form.has("password") ? { password: form.get("password") } : {}),
      ...(form.has("code") ? { code: form.get("code") } : {}),
    },
  };
}
