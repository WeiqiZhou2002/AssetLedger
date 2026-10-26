import { z } from "zod";
import { parse } from "csv-parse/sync";
import { dateSchema } from "@/lib/ledger/schemas";
import { invariant } from "@/lib/ledger/errors";
import { money } from "@/lib/money";
import { csvMappingSchema, type ParsedRow } from "./contracts";
import { maskDigits, normalizeMerchant, sha256 } from "./text";
import type { CsvMapping } from "./types";
export function readCsv(bytes: Uint8Array, skipRows = 0, relaxed = false) {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("invalid_csv_encoding");
  }
  invariant(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text), "文件不是 UTF-8 CSV");
  const records: string[][] = parse(text.split(/\r?\n/).slice(skipRows).join("\n"), {
    bom: true,
    skip_empty_lines: true,
    max_record_size: 20000,
    relax_column_count: relaxed,
  });
  invariant(records.length > 0 && records.length <= 10001, "CSV 行数须在 1–10001 之间");
  const [headers, ...rows] = records;
  invariant(
    headers.length >= 2 &&
      headers.length <= 100 &&
      headers.every((header) => header.length > 0 && header.length <= 200),
    "CSV 表头无效",
  );
  invariant(new Set(headers).size === headers.length, "CSV 表头不可重复");
  return { headers, rows, headerSignature: sha256(JSON.stringify(headers)) };
}
export function inspectCsv(bytes: Uint8Array) {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invariant(false, "文件不是 UTF-8 CSV");
  }
  invariant(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text), "文件不是 UTF-8 CSV");
  const records = z
    .array(z.object({ record: z.array(z.string()), info: z.object({ lines: z.number().int() }) }))
    .max(10101)
    .parse(
      parse(text, {
        bom: true,
        skip_empty_lines: true,
        max_record_size: 20000,
        relax_column_count: true,
        info: true,
      }),
    );
  invariant(records.length <= 10101, "CSV 行数超过限制");
  const first = records.find(
    ({ record, info }) =>
      info.lines <= 101 &&
      record.length >= 2 &&
      record.length <= 100 &&
      new Set(record).size === record.length &&
      record.every((cell) => cell.length > 0 && cell.length <= 200 && !/[\r\n]/.test(cell)),
  );
  invariant(first, "未找到有效的 CSV 表头");
  const skipRows = first.info.lines - 1;
  return { headers: first.record, headerSignature: sha256(JSON.stringify(first.record)), skipRows };
}
export const amexMapping: CsvMapping = {
  dateColumn: "Date",
  dateFormat: "MM/DD/YYYY",
  descriptionColumn: "Description",
  amountColumn: "Amount",
  signConvention: "positive_charge",
  skipRows: 0,
};
export function csvPreset(headers: string[]) {
  return headers.join(",") === "Date,Receipt,Description,Amount" ? amexMapping : null;
}
function csvAmount(value: string) {
  const raw = value.trim();
  if (!raw) return money("0");
  invariant(/^\(?[+-]?\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,4})?\)?-?$/.test(raw), "CSV 金额格式无效");
  const negative = raw.startsWith("-") || raw.startsWith("(") || raw.endsWith("-");
  return money((negative ? "-" : "") + raw.replace(/[^\d.]/g, ""));
}
function csvDate(value: string, format: CsvMapping["dateFormat"]) {
  if (format === "YYYY-MM-DD") return dateSchema.parse(value.trim());
  const match = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  invariant(match && match[3].length === (format.endsWith("YYYY") ? 4 : 2), "CSV 日期格式不匹配");
  const year = match[3].length === 2 ? (Number(match[3]) < 70 ? "20" : "19") + match[3] : match[3];
  return dateSchema.parse(`${year}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`);
}
export function parseCsv(
  bytes: Uint8Array,
  mapping: CsvMapping,
  account: { type: string; currency: string },
) {
  const config = csvMappingSchema.parse(mapping);
  const data = readCsv(bytes, config.skipRows);
  for (const column of [
    config.dateColumn,
    config.descriptionColumn,
    config.amountColumn,
    config.debitColumn,
    config.creditColumn,
    config.referenceColumn,
  ].filter(Boolean))
    invariant(data.headers.includes(column!), "映射列不存在");
  invariant(
    config.signConvention !== "positive_charge" || account.type === "liability_credit_card",
    "正数为消费的映射只适用于信用卡",
  );
  const rows: ParsedRow[] = data.rows.map((record) => {
    const cell = (column?: string) => (column ? (record[data.headers.indexOf(column)] ?? "") : "");
    const raw = config.amountColumn
      ? cell(config.amountColumn)
      : `${cell(config.debitColumn)} / ${cell(config.creditColumn)}`;
    let value = config.amountColumn
      ? csvAmount(raw)
      : csvAmount(cell(config.creditColumn))
          .abs()
          .minus(csvAmount(cell(config.debitColumn)).abs());
    if (config.amountColumn && config.signConvention === "positive_charge") value = value.negated();
    const description = maskDigits(cell(config.descriptionColumn)).slice(0, 2000);
    const date = csvDate(cell(config.dateColumn), config.dateFormat);
    const card = account.type === "liability_credit_card";
    const direction = card
      ? value.lt(0)
        ? "charge"
        : /PAYMENT/i.test(description)
          ? "payment"
          : "refund"
      : value.gt(0)
        ? "transfer_in"
        : "transfer_out";
    return {
      transaction_date: date,
      posted_date: date,
      description_raw: description,
      merchant_normalized: normalizeMerchant(description),
      amount_raw: raw,
      amount: value.toFixed(4),
      currency: account.currency,
      direction,
      confidence: "1.000",
      source_page: null,
      source_row_text: maskDigits(record.join(" | ")).slice(0, 4000),
      provider_transaction_id: cell(config.referenceColumn) || null,
    };
  });
  return { ...data, entries: rows };
}
