import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkConsumer, command } from "./consumer-check.ts";

const root = resolve(import.meta.dir, "..");
const scratch = join(root, ".tmp", `package-${randomUUID()}`);
mkdirSync(scratch, { recursive: true });
command([process.execPath, "pm", "pack", "--destination", scratch], root);
const tarball = join(
  scratch,
  readdirSync(scratch).find((file) => file.endsWith(".tgz")) ?? "missing",
);
const listing = command(["tar", "-tzf", tarball], root);
if (
  listing
    .split("\n")
    .some((file) =>
      /^package\/(?:tests|node_modules|\.tmp|\.github)\//.test(file),
    )
)
  throw new Error("Package includes development artifacts");
const consumer = join(scratch, "consumer with spaces");
const version = JSON.parse(
  await Bun.file(join(root, "package.json")).text(),
).version;
const result = checkConsumer(`file:${tarball}`, consumer, version, tarball, {
  verifyFork: true,
});
writeFileSync(
  join(scratch, "consumer-check.json"),
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(`Packed consumer passed: ${tarball}`);
