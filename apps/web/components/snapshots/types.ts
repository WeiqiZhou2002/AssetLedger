import type { listAccountGroups } from "@/lib/snapshots/groups";
import type { listFxRates } from "@/lib/snapshots/fx";
export type AccountGroup = Awaited<ReturnType<typeof listAccountGroups>>[number];
export type FxRate = Awaited<ReturnType<typeof listFxRates>>[number];
