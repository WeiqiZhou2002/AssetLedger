import { and, eq } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import { bankConnections, bankConnectionAccounts, journalEntries, postings, users } from "@/db/schema";
import { listAccounts } from "@/lib/ledger/accounts";
import { listSnapshots } from "@/lib/snapshots/service";
import { listFxRates } from "@/lib/snapshots/fx";
import { availabilityStart, effectiveFromDate } from "@/lib/bank-sync/date-range";
import { decimal } from "@/lib/money/fx";
import { invariant } from "@/lib/ledger/errors";
import { buildBackcast, type BackcastAccount, type BackcastInput } from "./backcast-core";
export { buildBackcast } from "./backcast-core";

type Account = Awaited<ReturnType<typeof listAccounts>>[number];
type Snapshot = Awaited<ReturnType<typeof listSnapshots>>[number];
function included(account: Account) {
  return (
    !account.isSystem &&
    ([
      "asset_cash",
      "asset_brokerage_cash",
      "asset_security",
      "liability_credit_card",
      "liability_loan",
    ].includes(account.type) ||
      (["asset_receivable", "asset_prepaid"].includes(account.type) && account.financialInclusion))
  );
}
function frozenRate(snapshot: Snapshot, currency: string, baseCurrency: string) {
  if (currency === baseCurrency) return "1";
  const quote =
    currency === snapshot.baseCurrency
      ? "1"
      : snapshot.fx.find((row) => row.quoteCurrency === currency)?.rate;
  const base =
    baseCurrency === snapshot.baseCurrency
      ? "1"
      : snapshot.fx.find((row) => row.quoteCurrency === baseCurrency)?.rate;
  return quote && base ? decimal(quote).div(base).toFixed(20) : null;
}
// Comparison markers may retain a complete aggregate observation, but never distribute it to accounts.
function snapshotMarkers(
  snapshots: Snapshot[],
  accounts: Account[],
  baseCurrency: string,
): BackcastInput["observations"] {
  return snapshots
    .filter((snapshot) => snapshot.isComplete)
    .flatMap((snapshot) => {
      const relevant = accounts.filter(
        (account) => included(account) && (!account.openedOn || account.openedOn <= snapshot.snapshotDate),
      );
      const covered = new Set<string>();
      let total = decimal("0");
      for (const item of snapshot.items) {
        const members = accounts.filter((account) =>
          item.accountId ? account.id === item.accountId : account.accountGroupId === item.accountGroupId,
        );
        if (item.accountGroupId && !members.length) return [];
        const selected = members.filter((member) => relevant.some((account) => account.id === member.id));
        if (!selected.length) continue;
        if (members.length !== selected.length) return [];
        const rate = frozenRate(snapshot, item.currency, baseCurrency);
        if (!rate || selected.some((member) => covered.has(member.id))) return [];
        selected.forEach((member) => covered.add(member.id));
        total = total.plus(decimal(item.balanceNative).div(rate));
      }
      if (!relevant.length || relevant.some((account) => !covered.has(account.id))) return [];
      return [{ date: snapshot.snapshotDate, snapshotId: snapshot.id, netWorth: total.toFixed(10) }];
    });
}
export async function loadBackcast(
  db: AppDb,
  ownerId: string,
  options: { from: string; to: string; baseCurrency: string },
) {
  const [accounts, allSnapshots, rates, records, mappings, connections, owner] = await Promise.all([
    listAccounts(db, ownerId),
    listSnapshots(db, ownerId),
    listFxRates(db, ownerId),
    db
      .select({
        accountId: postings.accountId,
        amount: postings.amount,
        entryId: journalEntries.id,
        eventDate: journalEntries.eventDate,
        postedDate: journalEntries.postedDate,
        type: journalEntries.entryType,
      })
      .from(journalEntries)
      .innerJoin(postings, and(eq(postings.journalEntryId, journalEntries.id), eq(postings.ownerId, ownerId)))
      .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.status, "confirmed"))),
    db
      .select({
        accountId: bankConnectionAccounts.accountId,
        connectionId: bankConnectionAccounts.connectionId,
        type: bankConnectionAccounts.type,
        isEnabled: bankConnectionAccounts.isEnabled,
        importFromDate: bankConnectionAccounts.importFromDate,
      })
      .from(bankConnectionAccounts)
      .where(eq(bankConnectionAccounts.ownerId, ownerId)),
    db
      .select({
        id: bankConnections.id,
        importFromDate: bankConnections.importFromDate,
        daysRequested: bankConnections.daysRequested,
        products: bankConnections.products,
        status: bankConnections.status,
        createdAt: bankConnections.createdAt,
      })
      .from(bankConnections)
      .where(eq(bankConnections.ownerId, ownerId)),
    db.select({ timezone: users.timezone }).from(users).where(eq(users.id, ownerId)),
  ]);
  invariant(owner[0], "用户不存在", 404);
  const dateFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone: owner[0].timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const snapshots = allSnapshots
    .filter((snapshot) => snapshot.status === "published" && snapshot.snapshotDate <= options.to)
    .sort(
      (a, b) =>
        b.snapshotDate.localeCompare(a.snapshotDate) ||
        b.updatedAt.getTime() - a.updatedAt.getTime() ||
        b.id.localeCompare(a.id),
    );
  const inputs: BackcastAccount[] = accounts.filter(included).map((account) => {
    const mapping = mappings.find((row) => row.accountId === account.id);
    const connection = mapping ? connections.find((row) => row.id === mapping.connectionId) : undefined;
    const plaidCoverageStart =
      connection && mapping
        ? [
            effectiveFromDate(connection, mapping),
            availabilityStart(dateFormat.format(connection.createdAt), connection.daysRequested),
          ]
            .sort()
            .at(-1)!
        : null;
    return {
      id: account.id,
      name: account.name,
      currency: account.currency,
      side: account.type.startsWith("liability_") ? "liability" : "asset",
      security: account.type === "asset_security",
      observationOnly: Boolean(
        mapping && connection && (mapping.type === "loan" || !connection.products.includes("transactions")),
      ),
      openedOn: account.openedOn,
      plaidCoverageStart,
      observations: snapshots.flatMap((snapshot) =>
        snapshot.items
          .filter((item) => item.accountId === account.id)
          .map((item) => ({
            date: snapshot.snapshotDate,
            balance: item.balanceNative,
            itemId: item.id,
            frozenRate: frozenRate(snapshot, account.currency, options.baseCurrency),
          })),
      ),
      flows: records
        .filter((row) => row.accountId === account.id)
        .map((row) => ({
          date: row.postedDate ?? row.eventDate,
          amount: row.amount,
          entryId: row.entryId,
          opening: row.type === "opening_balance",
        })),
    };
  });
  const available = connections
    .filter(
      (connection) =>
        connection.status !== "revoked" &&
        connection.products.includes("transactions") &&
        mappings.some(
          (mapping) =>
            mapping.connectionId === connection.id &&
            mapping.accountId &&
            mapping.isEnabled &&
            mapping.type !== "loan",
        ),
    )
    .map((connection) => availabilityStart(dateFormat.format(connection.createdAt), connection.daysRequested))
    .sort();
  return buildBackcast({
    ...options,
    accounts: inputs,
    plaidAvailability: available.length ? { earliest: available[0], latest: available.at(-1)! } : null,
    rates: rates
      .filter((rate) => rate.baseCurrency === options.baseCurrency)
      .map((rate) => ({
        currency: rate.quoteCurrency,
        rate: rate.rate,
        date: rate.observedOn,
        id: rate.id,
        createdAt: rate.createdAt.toISOString(),
      })),
    observations: snapshotMarkers(snapshots, accounts, options.baseCurrency),
  });
}
