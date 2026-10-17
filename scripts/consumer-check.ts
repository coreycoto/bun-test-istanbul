import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export function command(args: string[], cwd: string): string {
  const env = { ...process.env };
  delete env.BUN_OPTIONS;
  const result = Bun.spawnSync(args, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0 || result.signalCode) {
    throw new Error(
      `${args[1]} failed (exit ${result.exitCode}, signal ${result.signalCode}):\n${result.stdout.toString()}\n${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
}

/** A fresh consumer and cache; run both the shipped binary and exported API. */
export function checkConsumer(
  specifier: string,
  consumer: string,
  expectedVersion: string,
  expectedTarball?: string,
  options: { verifyFork?: boolean } = {},
) {
  if (existsSync(consumer))
    throw new Error("Consumer verification requires a fresh directory");
  mkdirSync(join(consumer, "src"), { recursive: true });
  mkdirSync(join(consumer, "tests"));
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      type: "module",
      dependencies: { "bun-test-istanbul": specifier },
    }),
  );
  command(
    [
      process.execPath,
      "install",
      "--ignore-scripts",
      `--cache-dir=${join(consumer, "cache")}`,
    ],
    consumer,
  );
  const installed = JSON.parse(
    readFileSync(
      join(consumer, "node_modules/bun-test-istanbul/package.json"),
      "utf8",
    ),
  );
  if (
    installed.name !== "bun-test-istanbul" ||
    installed.version !== expectedVersion
  )
    throw new Error("Installed package identity differs from expected release");
  if (expectedTarball) {
    const files = command(["tar", "-tzf", expectedTarball], consumer)
      .trim()
      .split("\n");
    for (const file of files) {
      if (
        !/^package\/(?:src\/[^/]+\.ts|README\.md|LICENSE|package\.json)$/.test(
          file,
        )
      )
        throw new Error("Unexpected verified package file");
      const expected = command(
        ["tar", "-xOf", expectedTarball, file],
        consumer,
      );
      const actual = readFileSync(
        join(
          consumer,
          "node_modules/bun-test-istanbul",
          file.slice("package/".length),
        ),
        "utf8",
      );
      if (actual !== expected)
        throw new Error(
          `Installed file differs from verified tarball: ${file}`,
        );
    }
  }
  writeFileSync(
    join(consumer, "src/math.ts"),
    "export function add(a: number, b: number) { return a + b; }",
  );
  writeFileSync(
    join(consumer, "tests/math.test.ts"),
    'import {expect,test} from "bun:test"; import {add} from "../src/math.ts"; test("adds",()=>expect(add(2,3)).toBe(5));',
  );
  command(
    [
      join(consumer, "node_modules/.bin/bun-test-istanbul"),
      "--reporter=json",
      "--reporter=lcovonly",
      "--",
      "./tests",
    ],
    consumer,
  );
  writeFileSync(
    join(consumer, "programmatic.ts"),
    `import {prepareCoverage,reportCoverage,MANIFEST_ENV,MANIFEST_HASH_ENV${options.verifyFork ? ",forkCoverage" : ""}} from "bun-test-istanbul";
const prepared=prepareCoverage();
const invocations=[prepared];
${options.verifyFork ? "invocations.push(forkCoverage({manifestPath:prepared.manifestPath,expectedHash:prepared.manifestSha256}));" : ""}
for (const run of invocations) {
const result=Bun.spawnSync([process.execPath,"--no-env-file","test","--preload","bun-test-istanbul/preload","./tests"],{
 env:{...process.env,[MANIFEST_ENV]:run.manifestPath,[MANIFEST_HASH_ENV]:run.manifestSha256},stdout:"inherit",stderr:"inherit"
});
if(result.exitCode!==0) throw new Error("Programmatic consumer tests failed");
reportCoverage({manifestPath:run.manifestPath,reporters:["json"]});
}`,
  );
  command([process.execPath, "--no-env-file", "./programmatic.ts"], consumer);
  const runs = readdirSync(join(consumer, "coverage/istanbul"));
  if (runs.length !== (options.verifyFork ? 3 : 2))
    throw new Error("Expected distinct CLI and API coverage runs");
  for (const run of runs) {
    const data = JSON.parse(
      readFileSync(
        join(consumer, "coverage/istanbul", run, "reports/coverage-final.json"),
        "utf8",
      ),
    );
    const file = data[join(consumer, "src/math.ts")];
    if (
      !file ||
      Object.values(file.f).length !== 1 ||
      Object.values(file.f)[0] !== 1
    )
      throw new Error(
        "Installed consumer coverage differs from executed add call",
      );
  }
  return {
    packageName: installed.name,
    version: installed.version,
    installedCLI: true,
    installedProgrammaticAPI: true,
    installedForkAPI: options.verifyFork ?? false,
    coverageRuns: runs.length,
  };
}
