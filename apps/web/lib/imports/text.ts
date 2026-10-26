import { createHash } from "node:crypto";
export function sha256(bytes: string | Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
export function maskDigits(text: string) {
  return text.replace(/\d{6,}/g, (value) => "*".repeat(value.length - 4) + value.slice(-4));
}
export function normalizeMerchant(value: string) {
  return maskDigits(value)
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 200);
}
export function similarDescription(a: string, b: string) {
  const left = normalizeMerchant(a);
  const right = normalizeMerchant(b);
  if (!left || !right) return false;
  if (left.includes(right) || right.includes(left)) return true;
  const l = new Set(left.split(" "));
  const r = new Set(right.split(" "));
  const intersection = [...l].filter((word) => r.has(word)).length;
  return intersection / new Set([...l, ...r]).size >= 0.5;
}
