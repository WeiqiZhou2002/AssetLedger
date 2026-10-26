import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { SESSION_COOKIE, validateSession } from "./session";
const currentSession = cache(async () =>
  validateSession(getDb(), (await cookies()).get(SESSION_COOKIE)?.value),
);
export async function requireUser() {
  const result = await currentSession();
  if (!result) redirect("/login");
  return result.user;
}
