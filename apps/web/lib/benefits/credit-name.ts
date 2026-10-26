const month =
  "(?:JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:T(?:EMBER)?)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)";
const namedDate = new RegExp(
  `\\b(?:${month}\\.?[\\s/-]+\\d{1,4}(?:[\\s,/-]+\\d{2,4})?|\\d{1,2}[\\s/-]+${month}\\.?(?:[\\s,/-]+\\d{2,4})?)\\b`,
  "g",
);

const issuerTokens =
  /\b(?:AMERICAN\s+EXPRESS|U\.?S\.?\s+BANK|CAPITAL\s+ONE|VENTURE\s+X|AMEX|PLATINUM|BUSINESS|GOLD|GREEN|CITIBANK|CITI|CHASE|SAPPHIRE|RESERVE|BILT|ALTITUDE|CARDMEMBER|CARD|STATEMENT|ADJUSTMENT)\b/g;
const brands = [
  "ChatGPT",
  "OpenAI",
  "Uber One",
  "Walmart+",
  "Resy",
  "Lululemon",
  "Oura",
  "CLEAR",
  "Saks",
  "Equinox",
  "Disney+",
  "Hulu",
  "Peacock",
  "YouTube",
  "Wireless",
  "Digital Entertainment",
  "Airline",
  "Hotel",
  "Dining",
];

/** Display grouping only; the source description remains on each linked entry. */
export function normalizedCreditName(description: string | null, merchant: string | null) {
  const text = (description?.trim() || merchant?.trim() || "").normalize("NFKC").toUpperCase();
  const cleaned = text
    .replace(
      /\b(?:REF(?:ERENCE)?(?:\s+(?:NO\.?|NUMBER|ID))?|(?:TRANSACTION|TXN|CONFIRMATION)(?:\s+(?:NO\.?|NUMBER|ID))?)[\s:#.-]+[A-Z0-9]+(?:[/-][A-Z0-9]+)*/g,
      " ",
    )
    .replace(
      /\b(?:CARD(?:\s+(?:ENDING(?:\s+IN)?|NO\.?|NUMBER|LAST\s*4))?|ENDING(?:\s+IN)?)\s*[:#-]?\s*[X*•]*\s*\d+\b/g,
      " ",
    )
    .replace(namedDate, " ")
    .replace(/\b(?=[\p{L}\p{N}]*\d)[\p{L}\p{N}]+\b/gu, " ")
    .replace(issuerTokens, " ")
    .replace(/[^\p{L}\s+]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const keyword = /\bBENEFITS?\b/.test(cleaned) && !/\bCREDITS?\b/.test(cleaned) ? "Benefit" : "Credit";
  let label = cleaned
    .replace(/\b(?:CREDITS?|BENEFITS?|REIMBURSEMENT|REIMB)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[\p{L}]/u.test(label)) return "其他权益";
  label = label
    .toLowerCase()
    .replace(/(^|\s)(\p{L})/gu, (_, space: string, letter: string) => space + letter.toUpperCase());
  for (const brand of brands) {
    const pattern = brand.replace("+", "\\+");
    label = label.replace(
      new RegExp(`(^|\\s)${pattern}(?=\\s|$)`, "gi"),
      (_, space: string) => space + brand,
    );
  }
  return `${label} ${keyword}`;
}
