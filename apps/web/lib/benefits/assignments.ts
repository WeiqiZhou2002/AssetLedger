import { and, eq, inArray } from "drizzle-orm";
import { journalEntries } from "@/db/schema";
import type { AppDb } from "@/db/types";

// Batch each generation, retaining only IDs. Voided ancestors still carry owner choices.
export async function benefitLineage(db: AppDb, ownerId: string, entryIds: string[]) {
  const parents = new Map<string, string | null>();
  let pending = [...new Set(entryIds)];
  while (pending.length) {
    const rows = await db
      .select({ id: journalEntries.id, parent: journalEntries.replacesEntryId })
      .from(journalEntries)
      .where(and(eq(journalEntries.ownerId, ownerId), inArray(journalEntries.id, pending)));
    for (const row of rows) parents.set(row.id, row.parent);
    pending = [
      ...new Set(rows.flatMap((row) => (row.parent && !parents.has(row.parent) ? [row.parent] : []))),
    ];
  }
  return parents;
}
export function replacementChain(entryId: string, parents: ReadonlyMap<string, string | null>) {
  const chain = new Set<string>();
  let id: string | null = entryId;
  while (id && !chain.has(id)) {
    chain.add(id);
    id = parents.get(id) ?? null;
  }
  return [...chain];
}
export function inheritedAssignments(
  entryIds: string[],
  parents: ReadonlyMap<string, string | null>,
  assignments: { entryId: string; creditId: string | null }[],
) {
  const own = new Map(assignments.map((row) => [row.entryId, row.creditId]));
  const resolved = new Map<string, string | null>();
  for (const id of entryIds) {
    const ancestor = replacementChain(id, parents).find((id) => own.has(id));
    if (ancestor) resolved.set(id, own.get(ancestor)!);
  }
  return resolved;
}
