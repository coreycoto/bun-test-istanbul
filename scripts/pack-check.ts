import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = join(root, ".tmp", `package-${randomUUID()}`);
mkdirSync(scratch, { recursive: true });
function command(args: string[], cwd = root) {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(
      `${args[1]} failed:\n${result.stdout.toString()}\n${result.stderr.toString()}`,
    );
  return result.stdout.toString();
}
command([process.execPath, "pm", "pack", "--destination", scratch]);
const tarball = join(
  scratch,
  readdirSync(scratch).find((file) => file.endsWith(".tgz")) ?? "missing",
);
const listing = command(["tar", "-tzf", tarball]);
if (
  listing
    .split("\n")
    .some((file) =>
      /^package\/(?:tests|node_modules|\.tmp|\.github)\//.test(file),
    )
)
  throw new Error("Package includes development artifacts");
const consumer = join(scratch, "consumer with spaces");
mkdirSync(join(consumer, "src"), { recursive: true });
mkdirSync(join(consumer, "tests"));
writeFileSync(
  join(consumer, "package.json"),
  JSON.stringify({
    type: "module",
    dependencies: { "bun-test-istanbul": `file:${tarball}` },
  }),
);
command([process.execPath, "install", "--ignore-scripts"], consumer);
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
  `import {prepareCoverage,reportCoverage,MANIFEST_ENV,MANIFEST_HASH_ENV} from "bun-test-istanbul";
const run=prepareCoverage();
const result=Bun.spawnSync([process.execPath,"--no-env-file","test","--preload","bun-test-istanbul/preload","./tests"],{
 env:{...process.env,[MANIFEST_ENV]:run.manifestPath,[MANIFEST_HASH_ENV]:run.manifestSha256},stdout:"inherit",stderr:"inherit"
});
if(result.exitCode!==0) throw new Error("Programmatic consumer tests failed");
reportCoverage({manifestPath:run.manifestPath,reporters:["json"]});`,
);
command([process.execPath, "--no-env-file", "./programmatic.ts"], consumer);
console.log(`Packed consumer passed: ${tarball}`);
