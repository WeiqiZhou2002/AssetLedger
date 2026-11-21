import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Children, isValidElement, type ChangeEvent, type ReactNode, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BenefitAssignmentSelect } from "@/components/benefits/assignment-select";
import { useLedgerMutation } from "@/components/ledger/forms";
vi.mock("@/components/ledger/forms", async (original) => ({
  ...(await original<typeof import("@/components/ledger/forms")>()),
  useLedgerMutation: vi.fn(),
}));
const props = {
  entryId: "synthetic-entry",
  productId: "synthetic-product",
  credits: [{ id: "coffee", name: "Coffee Credit" }],
  assignment: {
    automaticCreditId: "coffee",
    source: "keyword" as const,
    ownerAssigned: false,
    ownerCreditId: null,
  },
};
let pending = false,
  error = "";
let operation: Promise<void>;
beforeEach(() => {
  pending = false;
  error = "";
  vi.mocked(useLedgerMutation).mockImplementation(() => ({
    pending,
    error,
    run: (callback) => {
      pending = true;
      operation = callback()
        .catch((cause: Error) => {
          error = cause.message;
        })
        .finally(() => {
          pending = false;
        });
      return operation;
    },
  }));
});
afterEach(() => vi.unstubAllGlobals());
function select(node: ReactNode): ReactElement<React.ComponentProps<"select">> {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === "select") return child as ReactElement<React.ComponentProps<"select">>;
    if (child.props.children) {
      const found = select(child.props.children);
      if (found) return found;
    }
  }
  return undefined!;
}
it.each([
  ["credit:coffee", { mode: "credit", creditId: "coffee" }],
  ["none", { mode: "none" }],
  ["auto", { mode: "auto" }],
])("PUTs %s and disables while pending", async (choice, body) => {
  let respond: (response: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  select(BenefitAssignmentSelect(props)).props.onChange!({
    currentTarget: { value: choice },
  } as ChangeEvent<HTMLSelectElement>);
  expect(select(BenefitAssignmentSelect(props)).props.disabled).toBe(true);
  expect(fetch).toHaveBeenCalledWith("/api/benefits/assignments", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entryId: props.entryId, productId: props.productId, ...body }),
  });
  respond!(Response.json({ ok: true }));
  await operation;
  expect(select(BenefitAssignmentSelect(props)).props.disabled).toBe(false);
});
it("shows errors, keeps the owner choice and exposes the automatic result", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "卡产品已更改，请刷新后重试" }, { status: 400 })),
  );
  const assigned = {
    ...props,
    assignment: { ...props.assignment, ownerAssigned: true, ownerCreditId: "coffee" },
  };
  expect(select(BenefitAssignmentSelect(assigned)).props.value).toBe("credit:coffee");
  select(BenefitAssignmentSelect(assigned)).props.onChange!({
    currentTarget: { value: "auto" },
  } as ChangeEvent<HTMLSelectElement>);
  await operation;
  const html = renderToStaticMarkup(BenefitAssignmentSelect(assigned));
  expect(html).toContain("卡产品已更改，请刷新后重试");
  expect(html).toContain("自动匹配（Coffee Credit）");
  expect(
    select(
      BenefitAssignmentSelect({
        ...props,
        assignment: { ...props.assignment, ownerAssigned: true, ownerCreditId: null },
      }),
    ).props.value,
  ).toBe("none");
  expect(renderToStaticMarkup(BenefitAssignmentSelect({ ...props, assignment: undefined }))).toContain(
    "自动匹配（其他权益）",
  );
});
