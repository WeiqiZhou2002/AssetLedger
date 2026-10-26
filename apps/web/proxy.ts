import { NextRequest, NextResponse } from "next/server";
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const plaid = process.env.PLAID_ENABLED === "true";
  const plaidHost =
    process.env.PLAID_ENV === "production" ? "https://production.plaid.com" : "https://sandbox.plaid.com";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${plaid ? " https://cdn.plaid.com/link/v2/stable/link-initialize.js" : ""}${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${plaid ? ` ${plaidHost}` : ""}`,
    `frame-src ${plaid ? "https://cdn.plaid.com/" : "'none'"}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const publicPath = request.nextUrl.pathname === "/login" || request.nextUrl.pathname.startsWith("/api/");
  // Full DB validation is authoritative in the authenticated layout and every protected handler.
  const response =
    !publicPath && !request.cookies.get("al_session")?.value
      ? NextResponse.redirect(new URL("/login", request.url))
      : NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icons/|manifest.webmanifest).*)"],
};
