import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve, join } from "node:path";
import { invariant } from "@/lib/ledger/errors";
export function storageFile(dataDir: string, hash: string, ext: "pdf" | "csv") {
  invariant(/^[a-f0-9]{64}$/.test(hash), "文件标识无效");
  return join(resolve(dataDir), "statements", `${hash}.${ext}`);
}
export function safeFile(dataDir: string, path: string) {
  invariant(path.startsWith(join(resolve(dataDir), "statements") + "/"), "文件路径无效");
  invariant(resolve(path) === path, "文件路径无效");
  return path;
}
export async function persistFile(path: string, bytes: Uint8Array) {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
}
export function safeFilename(name: string) {
  return (
    basename(name.replaceAll("\\", "/"))
      .replace(/[\x00-\x1F]/g, "")
      .slice(0, 200) || "statement"
  );
}
export async function readStoredFile(dataDir: string, path: string) {
  return new Uint8Array(await readFile(safeFile(dataDir, path)));
}
export async function boundedForm(request: Request, maxBytes: number) {
  invariant(
    !request.headers.get("content-length") ||
      Number(request.headers.get("content-length")) <= maxBytes + 65536,
    "文件过大",
  );
  invariant(request.body, "请选择文件");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes + 65536) {
      await reader.cancel();
      invariant(false, "文件过大");
    }
    chunks.push(value);
  }
  const data = await new Request(request.url, {
    method: "POST",
    headers: { "content-type": request.headers.get("content-type") ?? "" },
    body: new Blob(chunks as BlobPart[]),
  }).formData();
  const file = data.get("file");
  invariant(file instanceof File && file.size > 0 && file.size <= maxBytes, "请选择有效且未超限的文件");
  return { data, file };
}
