export async function healthStatus(
  checkDb: () => Promise<unknown>,
  parserUrl: string,
  request: typeof fetch = fetch,
) {
  const [db, parser] = await Promise.all([
    checkDb().then(
      () => "ok" as const,
      () => "error" as const,
    ),
    parserUrl
      ? request(`${parserUrl.replace(/\/$/, "")}/health`, {
          signal: AbortSignal.timeout(3000),
          cache: "no-store",
        })
          .then(async (response) =>
            response.ok && (await response.json()).status === "ok" ? ("ok" as const) : ("error" as const),
          )
          .catch(() => "error" as const)
      : Promise.resolve("disabled" as const),
  ]);
  return {
    status: db === "error" ? "error" : parser === "error" ? "degraded" : "ok",
    db,
    parser,
    version: "0.1.0",
  };
}
