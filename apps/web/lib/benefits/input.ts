import { and, eq } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import { categories } from "@/db/schema";
import { buildPostings } from "@/lib/ledger/builders";
import { invariant } from "@/lib/ledger/errors";
import { benefitConfig, type BenefitFamily } from "./config";

export async function benefitInput(
  db: AppDb,
  ownerId: string,
  input: {
    accountId: string;
    amount: string;
    currency: string;
    eventDate: string;
    postedDate?: string | null;
    merchant?: string | null;
    description?: string | null;
    family: BenefitFamily;
  },
) {
  const available = await db
    .select()
    .from(categories)
    .where(
      and(eq(categories.ownerId, ownerId), eq(categories.kind, "expense"), eq(categories.isArchived, false)),
    );
  const category =
    benefitConfig[input.family].categories
      .map((name) => available.find((row) => row.name === name))
      .find(Boolean) ?? available.find((row) => row.name === "其他支出");
  invariant(category, "请恢复权益对应分类或其他支出分类");
  const entry = await buildPostings(db, ownerId, "refund", {
    amount: input.amount,
    toAccountId: input.accountId,
    categoryId: category.id,
    eventDate: input.eventDate,
    postedDate: input.postedDate,
    merchant: input.merchant,
    description: input.description,
    status: "confirmed",
  });
  return { ...entry, benefitCredit: true, benefitFamily: input.family };
}
