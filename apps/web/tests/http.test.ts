import { expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { assertOrigin, mutation, readJson, readOptionalJson } from "@/lib/auth/http";
import { healthStatus } from "@/lib/health";
import { readEnv } from "@/lib/env";
import { proxy } from "@/proxy";
it("rejects absent/cross-site origins and unexpected hosts", () => {
  const request = (origin: string, host: string) =>
    new Request("https://ledger.example.com/api/auth/logout", { method: "POST", headers: { origin, host } });
  expect(() =>
    assertOrigin(request("https://ledger.example.com", "ledger.example.com"), "https://ledger.example.com"),
  ).not.toThrow();
  for (const [origin, host] of [
    ["", "ledger.example.com"],
    ["https://evil.example.com", "ledger.example.com"],
    ["https://ledger.example.com", "evil.example.com"],
  ])
    expect(() => assertOrigin(request(origin, host), "https://ledger.example.com")).toThrow("请求来源");
});
it("mutation wrapper returns 403 before invoking handler", async () => {
  vi.stubEnv("APP_SECRET", "synthetic-secret-for-tests-at-least-32");
  vi.stubEnv("DATABASE_URL", "postgresql://example/test");
  vi.stubEnv("APP_URL", "https://ledger.example.com");
  const handler = vi.fn();
  expect(
    (
      await mutation(handler)(
        new NextRequest("https://ledger.example.com/api/auth/logout", {
          method: "POST",
          headers: { host: "ledger.example.com" },
        }),
      )
    ).status,
  ).toBe(403);
  expect(handler).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});
it("fails config validation without exposing values", () => {
  vi.stubEnv("APP_SECRET", "short-sensitive");
  expect(() => readEnv()).toThrow("APP_SECRET");
  try {
    readEnv();
  } catch (error) {
    expect(String(error)).not.toContain("short-sensitive");
  }
  vi.unstubAllEnvs();
});
it("health exposes only health enums and version", async () => {
  expect(await healthStatus(async () => {}, "")).toEqual({
    status: "ok",
    db: "ok",
    parser: "disabled",
    version: "0.2.0",
  });
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: "ok" }));
  expect(
    await healthStatus(
      async () => {
        throw new Error("secret connection string");
      },
      "http://parser:8000",
      request,
    ),
  ).toEqual({ status: "error", db: "error", parser: "ok", version: "0.2.0" });
  request.mockRejectedValue(new Error("offline"));
  expect(await healthStatus(async () => {}, "http://parser:8000", request)).toMatchObject({
    status: "degraded",
    db: "ok",
    parser: "error",
  });
});
it("proxy redirects missing cookies, permits health and adds nonce CSP", () => {
  const response = proxy(new NextRequest("http://localhost:3000/dashboard"));
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe("http://localhost:3000/login");
  expect(response.headers.get("content-security-policy")).toContain("'nonce-");
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(proxy(new NextRequest("http://localhost:3000/api/health")).status).toBe(200);
});
it("allows configured origin/host pairs without mixing them", () => {
  const request = (origin: string, host: string) =>
    new Request("http://localhost:3000/api/auth/logout", { headers: { origin, host } });
  const extra = " http://localhost:3000, https://second.example.com ";
  expect(() =>
    assertOrigin(request("http://localhost:3000", "localhost:3000"), "https://ledger.example.com", extra),
  ).not.toThrow();
  expect(() =>
    assertOrigin(
      request("https://second.example.com", "second.example.com"),
      "https://ledger.example.com",
      extra,
    ),
  ).not.toThrow();
  for (const [origin, host] of [
    ["http://localhost:3000", "ledger.example.com"],
    ["https://ledger.example.com", "localhost:3000"],
    ["http://localhost:3001", "localhost:3001"],
  ]) {
    expect(() => assertOrigin(request(origin, host), "https://ledger.example.com", extra)).toThrow(
      "请求来源",
    );
  }
});
it("treats loopback names as one origin only for loopback app URLs", () => {
  const request = (origin: string, host: string) =>
    new Request("http://127.0.0.1:3000/api/auth/login", { method: "POST", headers: { origin, host } });
  for (const [origin, host] of [
    ["http://localhost:3000", "localhost:3000"],
    ["http://127.0.0.1:3000", "127.0.0.1:3000"],
    ["http://[::1]:3000", "[::1]:3000"],
  ]) {
    expect(() => assertOrigin(request(origin, host), "http://localhost:3000")).not.toThrow();
    expect(() => assertOrigin(request(origin, host), "http://127.0.0.1:3000")).not.toThrow();
    expect(() =>
      assertOrigin(request(origin, host), "https://ledger.example.com", "http://localhost:3000"),
    ).not.toThrow();
  }
  expect(() => assertOrigin(request("http://127.0.0.1", "127.0.0.1"), "http://localhost")).not.toThrow();
  for (const [origin, host] of [
    ["http://127.0.0.1:3001", "127.0.0.1:3001"],
    ["https://127.0.0.1:3000", "127.0.0.1:3000"],
    ["http://127.0.0.1:3000", "localhost:3000"],
    ["http://localhost:3000", "127.0.0.1:3000"],
    ["http://127.0.0.2:3000", "127.0.0.2:3000"],
    ["http://evil.example.com:3000", "127.0.0.1:3000"],
  ]) {
    expect(() => assertOrigin(request(origin, host), "http://localhost:3000")).toThrow("请求来源");
  }
  for (const [origin, host] of [
    ["http://localhost:3000", "localhost:3000"],
    ["http://127.0.0.1", "127.0.0.1"],
    ["https://127.0.0.1", "127.0.0.1"],
  ]) {
    expect(() => assertOrigin(request(origin, host), "https://ledger.example.com")).toThrow("请求来源");
  }
});
it("rejects malformed configured extra origins without leaking config", () => {
  vi.stubEnv("EXTRA_ALLOWED_ORIGINS", "https://example.com/path");
  expect(() => readEnv()).toThrow("EXTRA_ALLOWED_ORIGINS");
  vi.unstubAllEnvs();
});

function jsonRequest(body?: string, contentType: string | null = "application/json") {
  const request = new NextRequest("http://localhost:3000/api/synthetic", {
    method: "POST",
    ...(body === undefined ? {} : { body }),
    ...(contentType === null ? {} : { headers: { "content-type": contentType } }),
  });
  // Fetch supplies text/plain for string bodies unless explicitly removed.
  if (contentType === null) request.headers.delete("content-type");
  return request;
}

it.each([undefined, "", " \r\n\t"])(
  "accepts absent/empty optional JSON without a content type: %j",
  async (body) => {
    for (const contentType of [null, "application/json", "text/plain"]) {
      const request = jsonRequest(body, contentType);
      expect(request.headers.get("content-type")).toBe(contentType);
      if (body !== undefined) expect(request.body).not.toBeNull();
      await expect(readOptionalJson(request)).resolves.toBeUndefined();
    }
  },
);

it("keeps required JSON content-type and empty-body failures unchanged", async () => {
  await expect(readJson(jsonRequest(undefined, null))).rejects.toMatchObject({ status: 415 });
  await expect(readJson(jsonRequest(undefined))).rejects.toMatchObject({
    status: 400,
    message: "请求内容为空",
  });
  for (const body of ["", " \r\n\t"]) {
    await expect(readJson(jsonRequest(body))).rejects.toBeInstanceOf(SyntaxError);
    await expect(readJson(jsonRequest(body, null))).rejects.toMatchObject({ status: 415 });
  }
});

it.each([
  { name: "required", read: readJson },
  { name: "optional", read: readOptionalJson },
])("validates and parses non-empty $name JSON with the existing content-type rules", async ({ read }) => {
  await expect(
    read(jsonRequest(' {"accountSelection":true} ', "application/json; charset=utf-8")),
  ).resolves.toEqual({ accountSelection: true });
  await expect(read(jsonRequest("null"))).resolves.toBeNull();
  await expect(read(jsonRequest("{"))).rejects.toBeInstanceOf(SyntaxError);
  for (const type of [null, "text/plain"])
    await expect(read(jsonRequest("{}", type))).rejects.toMatchObject({ status: 415 });
});

it.each([
  { name: "required", read: readJson },
  { name: "optional", read: readOptionalJson },
])("enforces byte limits for $name JSON and cancels an oversized multi-chunk stream", async ({ read }) => {
  const body = '{"name":"示例"}';
  const bytes = Buffer.byteLength(body, "utf8");
  await expect(read(jsonRequest(body), bytes)).resolves.toEqual({ name: "示例" });
  await expect(read(jsonRequest(body), bytes - 1)).rejects.toMatchObject({ status: 413 });
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("     "));
      controller.enqueue(new TextEncoder().encode("    "));
    },
    cancel,
  });
  const request = new Request("http://localhost:3000/api/synthetic", {
    method: "POST",
    body: stream,
    duplex: "half",
    headers: { "content-type": "application/json", "content-length": "1" },
  } as RequestInit);
  await expect(read(request, 8)).rejects.toMatchObject({ status: 413 });
  expect(cancel).toHaveBeenCalledOnce();
});

it("checks the optional body size even for whitespace without a content type", async () => {
  await expect(readOptionalJson(jsonRequest(" ".repeat(8193), null))).rejects.toMatchObject({ status: 413 });
});
