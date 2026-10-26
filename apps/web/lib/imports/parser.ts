import { statementResultSchema } from "./contracts";
export class ImportFailure extends Error {
  constructor(readonly kind: string) {
    super(kind);
  }
}
export class ParserClient {
  constructor(
    private readonly url: string,
    private readonly maxBytes: number,
  ) {}
  private async request(path: string, bytes: Uint8Array, values: Record<string, string> = {}) {
    if (!this.url) throw new ImportFailure("parser_disabled");
    const body = new FormData();
    body.set("file", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), "statement.pdf");
    for (const [key, value] of Object.entries(values)) body.set(key, value);
    let response: Response;
    try {
      response = await fetch(`${this.url.replace(/\/$/, "")}${path}`, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(120000),
      });
    } catch {
      throw new ImportFailure("parser_unavailable");
    }
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { detail?: unknown };
      const allowed = [
        "needs_password",
        "invalid_pdf",
        "page_limit",
        "file_too_large",
        "render_bounds",
        "parse_failed",
      ];
      throw new ImportFailure(
        typeof detail.detail === "string" && allowed.includes(detail.detail)
          ? detail.detail
          : "parser_failed",
      );
    }
    return response;
  }
  async unlock(bytes: Uint8Array, password?: string) {
    const response = await this.request("/unlock", bytes, { password: password ?? "" });
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length > this.maxBytes) throw new ImportFailure("file_too_large");
    return { bytes: data, pageCount: Number(response.headers.get("X-Page-Count")) };
  }
  async parse(bytes: Uint8Array) {
    const response = await this.request("/parse", bytes);
    const result = statementResultSchema.safeParse(await response.json());
    if (!result.success) throw new ImportFailure("parser_contract");
    return result.data;
  }
  async render(bytes: Uint8Array, page: number) {
    const response = await this.request("/render", bytes, { page: String(page), dpi: "120" });
    return new Uint8Array(await response.arrayBuffer());
  }
}
