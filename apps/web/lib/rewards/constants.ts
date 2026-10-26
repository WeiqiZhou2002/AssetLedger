export const programKinds = ["bank_points", "airline", "hotel", "cashback", "other"] as const;
export const manualEventTypes = [
  "earn",
  "bonus",
  "redeem",
  "refund",
  "expire",
  "purchase",
  "adjust",
] as const;
export const eventLabels: Record<(typeof manualEventTypes)[number] | "transfer_out" | "transfer_in", string> =
  {
    earn: "获得",
    bonus: "奖励",
    redeem: "兑换",
    transfer_out: "转出",
    transfer_in: "转入",
    refund: "退回",
    expire: "过期",
    purchase: "购买",
    adjust: "调整",
  };
export const defaultPrograms: {
  code: string;
  name: string;
  kind: (typeof programKinds)[number];
  unitLabel: string;
  baseline: string;
  personal: string;
}[] = [
  {
    code: "MR",
    name: "Amex Membership Rewards",
    kind: "bank_points",
    unitLabel: "点",
    baseline: "1",
    personal: "1.3",
  },
  {
    code: "UR",
    name: "Chase Ultimate Rewards",
    kind: "bank_points",
    unitLabel: "点",
    baseline: "1",
    personal: "1",
  },
  { code: "TYP", name: "Citi ThankYou", kind: "bank_points", unitLabel: "点", baseline: "1", personal: "1" },
  {
    code: "ALTITUDE",
    name: "U.S. Bank Altitude",
    kind: "bank_points",
    unitLabel: "点",
    baseline: "1",
    personal: "1",
  },
  { code: "HYATT", name: "World of Hyatt", kind: "hotel", unitLabel: "点", baseline: "1", personal: "1.5" },
  {
    code: "MARRIOTT",
    name: "Marriott Bonvoy",
    kind: "hotel",
    unitLabel: "点",
    baseline: "0.6",
    personal: "0.6",
  },
  { code: "HILTON", name: "Hilton Honors", kind: "hotel", unitLabel: "点", baseline: "1", personal: "1" },
  {
    code: "AA",
    name: "American Airlines AAdvantage",
    kind: "airline",
    unitLabel: "里程",
    baseline: "1",
    personal: "1.5",
  },
  { code: "DL", name: "Delta SkyMiles", kind: "airline", unitLabel: "里程", baseline: "1", personal: "1.2" },
  {
    code: "UA",
    name: "United MileagePlus",
    kind: "airline",
    unitLabel: "里程",
    baseline: "1",
    personal: "1",
  },
  { code: "AC", name: "Air Canada Aeroplan", kind: "airline", unitLabel: "点", baseline: "1", personal: "1" },
  { code: "AS", name: "Alaska Airlines", kind: "airline", unitLabel: "里程", baseline: "1", personal: "1.2" },
  {
    code: "CX",
    name: "Cathay Asia Miles",
    kind: "airline",
    unitLabel: "里程",
    baseline: "1",
    personal: "1.1",
  },
  {
    code: "VS",
    name: "Virgin Atlantic Flying Club",
    kind: "airline",
    unitLabel: "点",
    baseline: "1",
    personal: "1.1",
  },
  {
    code: "ANA",
    name: "ANA Mileage Club",
    kind: "airline",
    unitLabel: "里程",
    baseline: "1",
    personal: "1.1",
  },
];
