import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "asset-ledger setup-"));
  temporaryDirectories.push(root);
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  const elsewhere = join(root, "another working directory");
  for (const directory of [scripts, bin, elsewhere]) mkdirSync(directory);
  copyFileSync(join(repository, "scripts/setup.sh"), join(scripts, "setup.sh"));
  copyFileSync(join(repository, ".env.example"), join(root, ".env.example"));
  const calls = join(root, "docker-calls");
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
case "$*" in
  'compose version') [ "\${SETUP_TEST_FAILURE:-}" != compose ] ;;
  info) [ "\${SETUP_TEST_FAILURE:-}" != daemon ] ;;
  'compose up -d --build') [ "\${SETUP_TEST_FAILURE:-}" != build ] ;;
  'compose up -d --force-recreate --no-deps web worker') exit 0 ;;
  'compose ps --format {{.Health}} web')
    if [ "\${SETUP_TEST_FAILURE:-}" = health ]; then
      printf 'starting\\n'
    else
      printf 'healthy\\n'
    fi
    ;;
  *) exit 92 ;;
esac
`,
    { mode: 0o700 },
  );
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const envFile = join(root, ".env");
  return {
    root,
    envFile,
    contents: () => readFileSync(envFile, "utf8"),
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []),
    run(args = ["--no-start"], environment: Partial<NodeJS.ProcessEnv> = {}, input?: string) {
      const result = spawnSync("bash", [join(scripts, "setup.sh"), ...args], {
        cwd: elsewhere,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          ADMIN_EMAIL: syntheticEmail,
          ADMIN_PASSWORD: syntheticPassword,
          SETUP_TEST_CALLS: calls,
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

setupTest("passes the password only to first up, clears it on recreation and waits for health again", () => {
  const setup = fixture();
  const result = setup.run([]);
  expect(result.status, result.output).toBe(0);
  expect(setup.calls()).toEqual([
    "compose version|unset",
    "info|unset",
    "compose up -d --build|present",
    "compose ps --format {{.Health}} web|unset",
    "compose up -d --force-recreate --no-deps web worker|empty",
    "compose ps --format {{.Health}} web|unset",
  ]);
  expect(result.output).toContain("http://localhost:3000");
  expect(result.output).toContain(syntheticEmail);
  expect(result.output).not.toContain(syntheticPassword);
  expect(values(setup.contents()).ADMIN_PASSWORD).toBe("");
});

setupTest("starts an existing installation without prompts or needless password recreation", () => {
  const setup = fixture();
  expect(setup.run().status).toBe(0);
  const original = setup.contents();
  const result = setup.run([], { ADMIN_EMAIL: undefined, ADMIN_PASSWORD: undefined });
  expect(result.status, result.output).toBe(0);
  expect(setup.contents()).toBe(original);
  expect(setup.calls()).toEqual([
    "compose version|unset",
    "info|unset",
    "compose up -d --build|unset",
    "compose ps --format {{.Health}} web|unset",
  ]);
});

setupTest("clears the supplied bootstrap password without editing a legacy password in env", () => {
  const setup = fixture();
  expect(setup.run().status).toBe(0);
  const original = setup
    .contents()
    .replace("ADMIN_PASSWORD=\n", "ADMIN_PASSWORD=synthetic-legacy-password\n");
  writeFileSync(setup.envFile, original);
  const result = setup.run([]);
  expect(result.status, result.output).toBe(0);
  expect(setup.contents()).toBe(original);
  expect(setup.calls()).toContain("compose up -d --force-recreate --no-deps web worker|empty");
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

setupTest(
  "times out with logs guidance and retains env, without prematurely removing the bootstrap password",
  () => {
    const setup = fixture();
    const result = setup.run([], { SETUP_TEST_FAILURE: "health" });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("健康检查超时");
    expect(result.output).toContain("docker compose logs --tail=50 web");
    expect(existsSync(setup.envFile)).toBe(true);
    expect(setup.calls().filter((call) => call.startsWith("compose ps"))).toHaveLength(120);
    expect(setup.calls().some((call) => call.includes("--force-recreate"))).toBe(false);
    expect(result.output).not.toContain(syntheticPassword);
  },
);

setupTest("shows help without preparing env or invoking Docker", () => {
  const setup = fixture();
  const result = setup.run(["--help"]);
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain("--no-start");
  expect(existsSync(setup.envFile)).toBe(false);
  expect(setup.calls()).toEqual([]);
});
