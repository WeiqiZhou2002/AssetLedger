import { createHash } from "node:crypto";

export function orderedPairKeys(a: string, b: string) {
  return a < b ? { leftKey: a, rightKey: b } : { leftKey: b, rightKey: a };
}

// A stable public identifier must not expose upstream provider identifiers.
export function transferPairKey(a: string, b: string) {
  const { leftKey, rightKey } = orderedPairKeys(a, b);
  return createHash("sha256")
    .update(JSON.stringify([leftKey, rightKey]))
    .digest("hex");
}
