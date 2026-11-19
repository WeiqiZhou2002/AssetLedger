export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^\p{L}\p{N}+&]+/gu, " ")
    .trim();
}
export function keywordHits(text: string, keyword: string): boolean {
  const key = normalize(keyword);
  return Boolean(key) && ` ${normalize(text)} `.includes(` ${key} `);
}
