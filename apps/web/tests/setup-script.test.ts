import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const available = (command: string, args: string[]) => spawnSync(command, args).status === 0;
const setupTest = it.skipIf(!available("bash", ["--version"]) || !available("openssl", ["version"]));
const temporaryDirectories: string[] = [];
const syntheticEmail = "setup-owner@example.com";
const syntheticPassword = "synthetic password $with `symbols` \\ and 'quotes'";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture({ curl = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "asset-ledger setup-"));
  temporaryDirectories.push(root);
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  const elsewhere = join(root, "another working directory");
  for (const directory of [scripts, bin, elsewhere]) mkdirSync(directory);
  copyFileSync(join(repository, "scripts/setup.sh"), join(scripts, "setup.sh"));
  copyFileSync(join(repository, ".env.example"), join(root, ".env.example"));
  copyFileSync(join(repository, "docker-compose.yml"), join(root, "docker-compose.yml"));
  const calls = join(root, "docker-calls");
  const httpCalls = join(root, "http-calls");
  const clock = join(root, "clock");
  writeFileSync(clock, "0\n");
  // Isolate PATH so missing-curl coverage cannot accidentally use the host curl.
  for (const command of [
    "bash",
    "openssl",
    "awk",
    "dirname",
    "readlink",
    "tr",
    "mktemp",
    "chmod",
    "ln",
    "rm",
    "tee",
    "tail",
    "grep",
    "head",
    "cat",
  ]) {
    const resolved = spawnSync("bash", ["-c", 'command -v "$1"', "setup-test", command], {
      encoding: "utf8",
    });
    expect(resolved.status).toBe(0);
    symlinkSync(resolved.stdout.trim(), join(bin, command));
  }
  // All Docker operations are synthetic. Log only arguments and password presence.
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh
set -eu
password_state=unset
if [ "\${ADMIN_PASSWORD+x}" = x ]; then
  password_state=empty
  if [ -n "$ADMIN_PASSWORD" ]; then password_state=present; fi
fi
printf '%s|%s\\n' "$*" "$password_state" >> "$SETUP_TEST_CALLS"
if [ -n "\${SETUP_TEST_EXPECT_PROJECT:-}" ]; then
  [ "$COMPOSE_PROJECT_NAME" = "$SETUP_TEST_EXPECT_PROJECT" ] || exit 93
fi
case "$*" in
  'compose version') [ "\${SETUP_TEST_FAILURE:-}" != compose ] ;;
  info) [ "\${SETUP_TEST_FAILURE:-}" != daemon ] ;;
  'volume inspect '*) [ "\${SETUP_TEST_FAILURE:-}" = volume ] ;;
  'compose up -d --build')
    if [ "\${SETUP_TEST_FAILURE:-}" = port ]; then
      printf 'synthetic compose error: port is already allocated\\n' >&2
      exit 1
    fi
    [ "\${SETUP_TEST_FAILURE:-}" != build ]
    ;;
  'compose port web 3000')
    [ "\${SETUP_TEST_FAILURE:-}" != published-port ] || exit 1
    printf '%s\\n' "\${SETUP_TEST_ADDRESS:-127.0.0.1:3000}"
    ;;
  'compose ps --all --format json web')
    case "\${SETUP_TEST_FAILURE:-}" in
      exited|restarting) printf '{"State":"%s","Health":""}\\n' "$SETUP_TEST_FAILURE" ;;
      *) printf '{"State":"running","Health":"starting"}\\n' ;;
    esac
    ;;
  'compose logs --since '*)
    if [ "\${SETUP_TEST_FAILURE:-}" = database ]; then printf '{"kind":"db_unavailable"}\\n'; fi
    ;;
  'compose exec -T web node -e '*)
    [ "\${SETUP_TEST_FAILURE:-}" != health ] && [ "\${SETUP_TEST_FAILURE:-}" != database ]
    ;;
  'compose exec -T web node dist/admin.cjs --status')
    [ "\${SETUP_TEST_FAILURE:-}" != status ] || exit 1
    printf '{"kind":"admin_status","hasUsers":%s}\\n' "\${SETUP_TEST_HAS_USERS:-false}"
    ;;
  'compose exec -T -e ADMIN_PASSWORD web node dist/admin.cjs --if-empty --email '*)
    [ "$password_state" = present ] || exit 94
    digest="$(printf '%s' "$ADMIN_PASSWORD" | openssl dgst -sha256)"
    [ "\${digest##* }" = "$SETUP_TEST_PASSWORD_HASH" ] || exit 95
    [ "\${SETUP_TEST_FAILURE:-}" != admin ] || exit 1
    printf '{"kind":"admin_created","id":"synthetic-id"}\\n'
    ;;
  *) exit 92 ;;
esac
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, "date"),
    `#!/bin/sh
if [ "$*" = '+%s' ]; then cat "$SETUP_TEST_CLOCK"; else printf '2026-01-01T00:00:00Z\\n'; fi
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, "sleep"),
    `#!/bin/sh
read -r seconds < "$SETUP_TEST_CLOCK"
printf '%s\\n' "$((seconds + $1))" > "$SETUP_TEST_CLOCK"
`,
    { mode: 0o700 },
  );
  if (curl)
    writeFileSync(
      join(bin, "curl"),
      `#!/bin/sh
printf '%s|%s\\n' "$*" "\${ADMIN_PASSWORD+present}" >> "$SETUP_TEST_HTTP_CALLS"
[ "\${SETUP_TEST_FAILURE:-}" != health ] && [ "\${SETUP_TEST_FAILURE:-}" != database ]
`,
      { mode: 0o700 },
    );
  const envFile = join(root, ".env");
  return {
    root,
    envFile,
    contents: () => readFileSync(envFile, "utf8"),
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []),
    httpCalls: () => (existsSync(httpCalls) ? readFileSync(httpCalls, "utf8").trim().split("\n") : []),
    elapsed: () => Number(readFileSync(clock, "utf8")),
    run(args = ["--no-start"], environment: Partial<NodeJS.ProcessEnv> = {}, input?: string) {
      const result = spawnSync("bash", [join(scripts, "setup.sh"), ...args], {
        cwd: elsewhere,
        env: {
          ...process.env,
          PATH: bin,
          COMPOSE_PROJECT_NAME: undefined,
          ADMIN_EMAIL: syntheticEmail,
          ADMIN_PASSWORD: syntheticPassword,
          SETUP_TEST_CALLS: calls,
          SETUP_TEST_HTTP_CALLS: httpCalls,
          SETUP_TEST_CLOCK: clock,
          SETUP_TEST_PASSWORD_HASH: createHash("sha256").update(syntheticPassword).digest("hex"),
          SETUP_TEST_HAS_USERS: "false",
          SETUP_TEST_EXPECT_PROJECT: "asset-ledger",
          SETUP_TEST_FAILURE: "",
          ...environment,
        },
        encoding: "utf8",
        input,
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      return { ...result, output: result.stdout + result.stderr };
    },
  };
}

function values(contents: string) {
  return Object.fromEntries(
    contents
      .split("\n")
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

setupTest(
  "creates a private env with independent secrets, preserving the template and never persisting the password",
  () => {
    const setup = fixture();
    const result = setup.run();
    expect(result.status, result.output).toBe(0);
    expect(statSync(setup.envFile).mode & 0o777).toBe(0o600);
    const contents = setup.contents();
    const config = values(contents);
    expect(config.APP_SECRET).toMatch(/^[a-f0-9]{64}$/);
    expect(config.BACKUP_PASSPHRASE).toMatch(/^[a-f0-9]{64}$/);
    expect(config.BACKUP_PASSPHRASE).not.toBe(config.APP_SECRET);
    expect(config.POSTGRES_PASSWORD).toMatch(/^[a-f0-9]{64}$/);
    expect(config.POSTGRES_PASSWORD).not.toBe("replace-with-random-hex-password");
    expect(config.ADMIN_EMAIL).toBe(syntheticEmail);
    expect(config.ADMIN_PASSWORD).toBe("");
    expect(config.APP_URL).toBe("http://localhost:3000");
    expect(config.PLAID_ENABLED).toBe("false");
    expect(config.TZ).not.toBe("");
    expect(contents).not.toContain(syntheticPassword);
    for (const secret of [
      syntheticPassword,
      config.APP_SECRET,
      config.POSTGRES_PASSWORD,
      config.BACKUP_PASSPHRASE,
    ]) {
      expect(result.output).not.toContain(secret);
    }
    const unchangedLines = (text: string) =>
      text
        .split("\n")
        .filter((line) => !/^(APP_SECRET|POSTGRES_PASSWORD|BACKUP_PASSPHRASE|ADMIN_EMAIL|TZ)=/.test(line));
    expect(unchangedLines(contents)).toEqual(
      unchangedLines(readFileSync(join(setup.root, ".env.example"), "utf8")),
    );
    expect(setup.calls()).toEqual([]);
  },
);

setupTest("leaves an existing env byte-identical without asking for or validating credentials", () => {
  const setup = fixture();
  expect(setup.run().status).toBe(0);
  const customContents =
    setup.contents().replace("PLAID_ENABLED=false", "PLAID_ENABLED=true") + "# preserved\n";
  writeFileSync(setup.envFile, customContents);
  const before = statSync(setup.envFile);
  const result = setup.run(["--no-start"], { ADMIN_EMAIL: "invalid", ADMIN_PASSWORD: "short" });
  expect(result.status, result.output).toBe(0);
  expect(setup.contents()).toBe(customContents);
  expect(statSync(setup.envFile).mtimeMs).toBe(before.mtimeMs);
  expect(statSync(setup.envFile).mode).toBe(before.mode);
  expect(result.output).toContain("发现已有 .env");
  expect(setup.calls()).toEqual([]);
});

setupTest.each([
  { ADMIN_EMAIL: "invalid", message: "邮箱格式无效" },
  { ADMIN_EMAIL: "unsafe$(command)@example.com", message: "邮箱格式无效" },
  { ADMIN_EMAIL: "owner@example.com\nAPP_SECRET=unsafe", message: "邮箱格式无效" },
  { ADMIN_PASSWORD: "short", message: "12–1024" },
  { ADMIN_PASSWORD: "", message: "12–1024" },
  { ADMIN_PASSWORD: "s".repeat(1025), message: "12–1024" },
])("rejects invalid credentials before writing any env: $message", ({ message, ...environment }) => {
  const setup = fixture();
  const result = setup.run(["--no-start"], environment);
  expect(result.status).not.toBe(0);
  expect(result.output).toContain(message);
  expect(existsSync(setup.envFile)).toBe(false);
});

setupTest("reads and confirms an interactive password without echoing it", () => {
  const setup = fixture();
  const result = setup.run(
    ["--no-start"],
    { ADMIN_EMAIL: undefined, ADMIN_PASSWORD: undefined },
    `${syntheticEmail}\n${syntheticPassword}\n${syntheticPassword}\n`,
  );
  expect(result.status, result.output).toBe(0);
  expect(values(setup.contents()).ADMIN_EMAIL).toBe(syntheticEmail);
  expect(result.output).not.toContain(syntheticPassword);
  expect(setup.contents()).not.toContain(syntheticPassword);
});

setupTest("rejects a mismatched confirmation without creating env", () => {
  const setup = fixture();
  const result = setup.run(
    ["--no-start"],
    { ADMIN_PASSWORD: undefined },
    `${syntheticPassword}\na different synthetic password\n`,
  );
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("两次输入的密码不一致");
  expect(existsSync(setup.envFile)).toBe(false);
});

setupTest(
  "uses HTTP readiness immediately and passes the password only in the admin exec environment",
  () => {
    const setup = fixture();
    const result = setup.run([]);
    expect(result.status, result.output).toBe(0);
    expect(setup.calls()).toEqual([
      "compose version|unset",
      "info|unset",
      "volume inspect asset-ledger_postgres|unset",
      "compose up -d --build|unset",
      "compose port web 3000|unset",
      "compose ps --all --format json web|unset",
      "compose exec -T web node dist/admin.cjs --status|unset",
      `compose exec -T -e ADMIN_PASSWORD web node dist/admin.cjs --if-empty --email ${syntheticEmail}|present`,
    ]);
    expect(setup.httpCalls()).toEqual([
      "--noproxy * --fail --silent --output /dev/null --max-time 5 http://127.0.0.1:3000/api/health|",
    ]);
    expect(setup.elapsed()).toBe(0);
    expect(setup.calls().join("\n")).not.toContain(syntheticPassword);
    expect(result.output).toContain("http://localhost:3000");
    expect(result.output).toContain(syntheticEmail);
    expect(result.output).not.toContain(syntheticPassword);
    expect(values(setup.contents()).ADMIN_PASSWORD).toBe("");
  },
);

setupTest("skips admin creation and prompts when users already exist", () => {
  const setup = fixture();
  expect(setup.run().status).toBe(0);
  const original = setup.contents();
  const result = setup.run([], {
    ADMIN_EMAIL: undefined,
    ADMIN_PASSWORD: undefined,
    SETUP_TEST_HAS_USERS: "true",
  });
  expect(result.status, result.output).toBe(0);
  expect(setup.contents()).toBe(original);
  expect(setup.calls()).toEqual([
    "compose version|unset",
    "info|unset",
    "compose up -d --build|unset",
    "compose port web 3000|unset",
    "compose ps --all --format json web|unset",
    "compose exec -T web node dist/admin.cjs --status|unset",
  ]);
  expect(result.output).toContain("已有管理员，跳过创建");
});

setupTest("preserves a legacy env password without adding any password to compose up", () => {
  const setup = fixture();
  expect(setup.run().status).toBe(0);
  const original = setup
    .contents()
    .replace("ADMIN_PASSWORD=\n", "ADMIN_PASSWORD=synthetic-legacy-password\n");
  writeFileSync(setup.envFile, original);
  const result = setup.run([], { SETUP_TEST_HAS_USERS: "true" });
  expect(result.status, result.output).toBe(0);
  expect(setup.contents()).toBe(original);
  expect(setup.calls()).toContain("compose up -d --build|unset");
  expect(setup.calls().every((call) => call.endsWith("|unset"))).toBe(true);
  expect(setup.calls().some((call) => call.includes("--force-recreate"))).toBe(false);
});

setupTest("creates the missing admin on a later run using environment presets", () => {
  const setup = fixture();
  expect(setup.run().status).toBe(0);
  const original = setup.contents();
  const result = setup.run([], { ADMIN_EMAIL: "another-owner@example.com" });
  expect(result.status, result.output).toBe(0);
  expect(setup.contents()).toBe(original);
  expect(setup.calls()).toContain(
    "compose exec -T -e ADMIN_PASSWORD web node dist/admin.cjs --if-empty --email another-owner@example.com|present",
  );
});

setupTest("prompts for a missing admin with the existing env email as default", () => {
  const setup = fixture();
  expect(setup.run().status).toBe(0);
  const original = setup
    .contents()
    .replace(`ADMIN_EMAIL=${syntheticEmail}`, `ADMIN_EMAIL='${syntheticEmail}'`);
  writeFileSync(setup.envFile, original);
  const result = setup.run(
    [],
    { ADMIN_EMAIL: undefined, ADMIN_PASSWORD: undefined },
    `\n${syntheticPassword}\n${syntheticPassword}\n`,
  );
  expect(result.status, result.output).toBe(0);
  expect(setup.contents()).toBe(original);
  expect(setup.calls()).toContain(
    `compose exec -T -e ADMIN_PASSWORD web node dist/admin.cjs --if-empty --email ${syntheticEmail}|present`,
  );
  expect(result.output).not.toContain(syntheticPassword);
});

setupTest("refuses an existing database volume before writing env or starting containers", () => {
  const setup = fixture();
  const result = setup.run([], { SETUP_TEST_FAILURE: "volume" });
  expect(result.status).not.toBe(0);
  expect(existsSync(setup.envFile)).toBe(false);
  expect(setup.calls()).toEqual([
    "compose version|unset",
    "info|unset",
    "volume inspect asset-ledger_postgres|unset",
  ]);
  expect(result.output).toContain("未写入 .env");
  expect(result.output).toContain("POSTGRES_PASSWORD");
  expect(result.output).toContain("在本目录运行 scripts/setup.sh --project-name <新名字>");
  expect(result.output).toContain("docker volume rm asset-ledger_postgres asset-ledger_uploads");
  expect(result.output).toContain("先备份");
});

setupTest("persists an explicit project name and uses it for every Docker command", () => {
  const setup = fixture();
  const result = setup.run(["--project-name", "second-ledger_2"], {
    COMPOSE_PROJECT_NAME: "overridden-project",
    SETUP_TEST_EXPECT_PROJECT: "second-ledger_2",
  });
  expect(result.status, result.output).toBe(0);
  expect(values(setup.contents()).COMPOSE_PROJECT_NAME).toBe("second-ledger_2");
  expect(setup.calls()).toContain("volume inspect second-ledger_2_postgres|unset");
  const rerun = setup.run([], { SETUP_TEST_EXPECT_PROJECT: "second-ledger_2", SETUP_TEST_HAS_USERS: "true" });
  expect(rerun.status, rerun.output).toBe(0);
});

setupTest("refuses --project-name with an existing env without changing the file", () => {
  const setup = fixture();
  expect(setup.run().status).toBe(0);
  const original = setup.contents();
  const result = setup.run(["--project-name", "second-ledger"]);
  expect(result.status).not.toBe(0);
  expect(setup.contents()).toBe(original);
  expect(result.output).toContain("COMPOSE_PROJECT_NAME=second-ledger");
  expect(result.output).toContain("手动添加或更新");
  expect(setup.calls()).toEqual([]);
});

setupTest.each(["", "Uppercase", "-starts-with-dash", "contains space", "unsafe;command"])(
  "rejects invalid project name %s without writing env",
  (name) => {
    const setup = fixture();
    const result = setup.run(["--no-start", "--project-name", name]);
    expect(result.status).not.toBe(0);
    expect(existsSync(setup.envFile)).toBe(false);
    expect(setup.calls()).toEqual([]);
  },
);

setupTest("honors COMPOSE_PROJECT_NAME from the environment for volume checks", () => {
  const setup = fixture();
  const result = setup.run([], {
    COMPOSE_PROJECT_NAME: "environment-project",
    SETUP_TEST_EXPECT_PROJECT: "environment-project",
    SETUP_TEST_FAILURE: "volume",
  });
  expect(result.status).not.toBe(0);
  expect(setup.calls()).toContain("volume inspect environment-project_postgres|unset");
  expect(result.output).toContain("environment-project_postgres");
  expect(existsSync(setup.envFile)).toBe(false);
});

setupTest("resolves quoted env project names and lets the environment take precedence", () => {
  const setup = fixture();
  expect(setup.run().status).toBe(0);
  writeFileSync(setup.envFile, setup.contents() + '\nCOMPOSE_PROJECT_NAME="file-project" # synthetic\n');
  for (const name of [undefined, "environment-project"]) {
    const result = setup.run([], {
      COMPOSE_PROJECT_NAME: name,
      SETUP_TEST_EXPECT_PROJECT: name ?? "file-project",
      SETUP_TEST_HAS_USERS: "true",
    });
    expect(result.status, result.output).toBe(0);
  }
});

setupTest.each([
  ["127.0.0.1:4123", "127.0.0.1:4123"],
  ["0.0.0.0:4123", "127.0.0.1:4123"],
  ["[::]:4123", "[::1]:4123"],
])("uses the published address %s and shows the correct port", (address, requestAddress) => {
  const setup = fixture();
  const result = setup.run([], { SETUP_TEST_ADDRESS: address });
  expect(result.status, result.output).toBe(0);
  expect(setup.httpCalls()[0]).toContain(`http://${requestAddress}/api/health`);
  expect(result.output).toContain("http://localhost:4123");
});

setupTest("falls back to the default published address", () => {
  const setup = fixture();
  const result = setup.run([], { SETUP_TEST_FAILURE: "published-port" });
  expect(result.status, result.output).toBe(0);
  expect(setup.httpCalls()[0]).toContain("http://127.0.0.1:3000/api/health");
});

setupTest("uses in-container fetch when curl is unavailable", () => {
  const setup = fixture({ curl: false });
  const result = setup.run([]);
  expect(result.status, result.output).toBe(0);
  expect(setup.httpCalls()).toEqual([]);
  expect(setup.calls().some((call) => call.startsWith("compose exec -T web node -e fetch("))).toBe(true);
});

setupTest.each([
  ["compose", "Docker Compose v2"],
  ["daemon", "请启动 Docker Desktop"],
])("fails preflight without writing env when %s is unavailable", (failure, message) => {
  const setup = fixture();
  const result = setup.run([], { SETUP_TEST_FAILURE: failure });
  expect(result.status).not.toBe(0);
  expect(result.output).toContain(message);
  expect(existsSync(setup.envFile)).toBe(false);
});

setupTest("times out after five minutes with logs guidance and retains env without creating an admin", () => {
  const setup = fixture();
  const result = setup.run([], { SETUP_TEST_FAILURE: "health" });
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("健康检查超时");
  expect(result.output).toContain("docker compose logs --tail=50 web");
  expect(existsSync(setup.envFile)).toBe(true);
  expect(setup.elapsed()).toBe(300);
  expect(setup.calls().filter((call) => call.startsWith("compose ps"))).toHaveLength(150);
  expect(setup.calls().some((call) => call.includes("dist/admin.cjs"))).toBe(false);
  expect(setup.calls().some((call) => call.includes("--force-recreate"))).toBe(false);
  expect(result.output).not.toContain(syntheticPassword);
});

setupTest("diagnoses db_unavailable after 30 seconds without touching existing volumes", () => {
  const setup = fixture();
  expect(setup.run(["--no-start", "--project-name", "diagnostic-project"]).status).toBe(0);
  const original = setup.contents();
  const result = setup.run([], {
    SETUP_TEST_FAILURE: "database",
    SETUP_TEST_EXPECT_PROJECT: "diagnostic-project",
  });
  expect(result.status).not.toBe(0);
  expect(setup.elapsed()).toBe(30);
  expect(result.output).toContain("db_unavailable");
  expect(result.output).toContain("diagnostic-project_postgres");
  expect(result.output).toContain("另一份 .env 中不同的 POSTGRES_PASSWORD");
  expect(result.output).toContain("在 .env 末尾加入 COMPOSE_PROJECT_NAME=<新名字>");
  expect(setup.contents()).toBe(original);
  expect(setup.calls().some((call) => call.startsWith("volume "))).toBe(false);
  expect(setup.calls().some((call) => call.includes("dist/admin.cjs"))).toBe(false);
});

setupTest.each(["exited", "restarting"])("fails early for a %s web container", (state) => {
  const setup = fixture();
  const result = setup.run([], { SETUP_TEST_FAILURE: state });
  expect(result.status).not.toBe(0);
  expect(setup.elapsed()).toBe(0);
  expect(result.output).toContain("docker compose logs --tail=50 web");
  expect(setup.calls().some((call) => call.includes("dist/admin.cjs"))).toBe(false);
});

setupTest("explains a port allocation failure and allows a later setup run to finish", () => {
  const setup = fixture();
  const failed = setup.run([], { SETUP_TEST_FAILURE: "port" });
  expect(failed.status).not.toBe(0);
  expect(failed.output).toContain("synthetic compose error: port is already allocated");
  expect(failed.output).toContain("修改 docker-compose.yml 中 web 的宿主机端口");
  expect(failed.output).toContain("APP_URL");
  expect(setup.calls().some((call) => call.includes("compose ps"))).toBe(false);
  const original = setup.contents();
  const recovered = setup.run([]);
  expect(recovered.status, recovered.output).toBe(0);
  expect(setup.contents()).toBe(original);
});

setupTest.each([
  ["status", "无法查询管理员状态"],
  ["admin", "创建管理员失败"],
])("fails without reporting success when %s fails", (failure, message) => {
  const setup = fixture();
  const result = setup.run([], { SETUP_TEST_FAILURE: failure });
  expect(result.status).not.toBe(0);
  expect(result.output).toContain(message);
  expect(result.output).not.toContain("请打开");
  expect(result.output).not.toContain(syntheticPassword);
  expect(existsSync(setup.envFile)).toBe(true);
});

setupTest("shows help without preparing env or invoking Docker", () => {
  const setup = fixture();
  const result = setup.run(["--help"]);
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain("--no-start");
  expect(result.output).toContain("--project-name");
  expect(result.output).not.toContain("export ADMIN_PASSWORD");
  expect(existsSync(setup.envFile)).toBe(false);
  expect(setup.calls()).toEqual([]);
});
