import { z } from "zod";
import { decryptSecret, encryptSecret } from "./crypto";
export const CHALLENGE_COOKIE = "al_challenge";
const schema = z.object({
  userId: z.uuid(),
  passwordFingerprint: z.string(),
  ipHash: z.string(),
  issuedAt: z.number(),
});
type LoginChallenge = z.infer<typeof schema>;
export function createChallenge(challenge: LoginChallenge, appSecret: string) {
  return encryptSecret(JSON.stringify(challenge), appSecret, "login-challenge");
}
export function readChallenge(
  value: string | undefined,
  appSecret: string,
  now: Date,
): LoginChallenge | null {
  if (!value || value.length > 2048) return null;
  try {
    const challenge = schema.parse(JSON.parse(decryptSecret(value, appSecret, "login-challenge")));
    const age = now.getTime() - challenge.issuedAt;
    return age >= 0 && age < 5 * 60000 ? challenge : null;
  } catch {
    return null;
  }
}
