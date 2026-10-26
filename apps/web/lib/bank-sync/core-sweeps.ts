export const CORE_SWEEP_NOTE = "Fidelity SPAXX 核心仓位申购/赎回，已忽略";

export function isCoreSweep(text: string): boolean {
  return (
    /\bSPAXX\b/i.test(text) &&
    /\b(?:redemption|redeem(?:ed)?|purchase(?:d)?|bought|sold|reinvest(?:ment)?)\b/i.test(text)
  );
}
