import "./env";
import { parseArgs } from "node:util";
import { getDb, getPool } from "@/db/client";
import { seedDemo } from "@/lib/ledger/seed";
import { todayInTimezone } from "@/lib/ledger/format";
async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    options: { demo: { type: "boolean" } },
  });
  if (!values.demo || !process.env.DEMO_EMAIL || !process.env.DEMO_PASSWORD) {
    throw new Error("demo_configuration_required");
  }
  try {
    const result = await seedDemo(getDb(), {
      email: process.env.DEMO_EMAIL,
      password: process.env.DEMO_PASSWORD,
      today: todayInTimezone("America/Los_Angeles"),
    });
    console.log(JSON.stringify({ kind: "demo_seed_complete", id: result.ownerId }));
  } finally {
    await getPool().end();
  }
}
main().catch(() => {
  console.error(
    "演示数据创建失败：需要 --demo、独立 DEMO_EMAIL、至少 12 字符的 DEMO_PASSWORD 和数据库连接。",
  );
  process.exitCode = 1;
});
