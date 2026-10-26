import { and, eq } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import { accounts, institutions } from "@/db/schema";
import { createAccount, createInstitution } from "@/lib/ledger/accounts";
import { auditLedger } from "@/lib/ledger/audit";
import { lockOwnerStructure } from "@/lib/snapshots/groups";
import { importedAccountSchema, uniqueAccountName } from "./account-defaults";

export async function createImportedAccount(
  db: AppDb,
  ownerId: string,
  input: unknown,
  institution: { name: string; plaidInstitutionId?: string | null },
) {
  const values = importedAccountSchema.parse(input);
  return db.transaction(async (tx) => {
    await lockOwnerStructure(tx, ownerId);
    const name = institution.name.trim().slice(0, 100) || "未命名机构";
    const own = await tx.select().from(institutions).where(eq(institutions.ownerId, ownerId));
    let matched =
      own.find(
        (row) => institution.plaidInstitutionId && row.plaidInstitutionId === institution.plaidInstitutionId,
      ) ?? own.find((row) => row.name.toLowerCase() === name.toLowerCase());
    if (!matched) {
      matched = await createInstitution(tx, ownerId, {
        name,
        kind:
          values.type === "liability_credit_card"
            ? "card_issuer"
            : ["asset_brokerage_cash", "asset_security"].includes(values.type)
              ? "brokerage"
              : "bank",
      });
    }
    if (institution.plaidInstitutionId && !matched.plaidInstitutionId) {
      await tx
        .update(institutions)
        .set({ plaidInstitutionId: institution.plaidInstitutionId })
        .where(and(eq(institutions.ownerId, ownerId), eq(institutions.id, matched.id)));
      await auditLedger(tx, ownerId, "institution", matched.id, "institution.plaid_link");
    }
    const names = await tx
      .select({ name: accounts.name })
      .from(accounts)
      .where(eq(accounts.ownerId, ownerId));
    return createAccount(tx, ownerId, {
      ...values,
      name: uniqueAccountName(
        values.name,
        names.map((row) => row.name),
      ),
      institutionId: matched.id,
    });
  });
}
