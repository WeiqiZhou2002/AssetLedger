import QRCode from "qrcode";
import { getDb } from "@/db/client";
import { readEnv } from "@/lib/env";
import { startTotpEnrollment } from "@/lib/auth/totp";
import { authenticated, HttpError, json, mutation } from "@/lib/auth/http";
export const POST = mutation(async (request) => {
  const { user } = await authenticated(request);
  if (user.totpEnabledAt) throw new HttpError(409, "两步验证已启用");
  const { uri, secret } = await startTotpEnrollment(getDb(), user.id, readEnv().APP_SECRET);
  return json({ qrCode: await QRCode.toDataURL(uri, { width: 240, margin: 2 }), secret });
});
