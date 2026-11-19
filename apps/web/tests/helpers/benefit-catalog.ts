import type { Catalog, CatalogCard } from "@/lib/benefits/catalog";
export function syntheticCatalog(): Catalog {
  const card: CatalogCard = {
    id: "example-voyager",
    name: "Voyager Card",
    issuer: "Example Bank",
    currency: "USD",
    audience: "personal",
    availability: "open",
    coverage: "reviewed",
    aliases: ["VOYAGER"],
    sources: [
      {
        id: "example-source",
        url: "https://example.com/benefits",
        title: "Example terms",
        accessed: "2026-01-01",
      },
    ],
    credits: [
      {
        id: "coffee",
        name: "Coffee Credit",
        category: "dining",
        family: "dining",
        delivery: "statement_credit",
        enrollment: "required",
        match: { keywords: ["BEANHOUSE"] },
        versions: [
          {
            effective_from: null,
            effective_to: null,
            status: "verified",
            amount: "10.00",
            period: "monthly",
            reset_basis: "calendar",
            max_posting_lag_days: null,
            last_verified: "2026-01-01",
            tracking: { supported: true, reasons: [] },
          },
        ],
      },
    ],
  };
  return {
    catalogVersion: "synthetic-v1",
    cards: [card, { ...structuredClone(card), id: "example-other", name: "Other Card" }],
  };
}
