import "./env";
import { getDb, getPool } from "@/db/client";
import { readEnv } from "@/lib/env";
import { runResetCli } from "@/lib/bank-sync/reset-cli";
runResetCli(getDb(), readEnv(), process.argv.slice(2))
  .then((result) => console.log(JSON.stringify(result)))
  .catch(() => {
    console.error("重置未完成：请核对所有者、连接环境/状态、日期和数据目录权限；默认仅预览。");
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPool().end();
  });
