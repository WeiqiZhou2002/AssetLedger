import type { benefitOverview } from "@/lib/benefits/queries";
export type BenefitData = Awaited<ReturnType<typeof benefitOverview>>;
export type BenefitCard = BenefitData["cards"][number];
export type CatalogDetails = Extract<NonNullable<BenefitCard["catalog"]>, { productName: string }>;
