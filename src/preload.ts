import { afterAll } from "bun:test";
import { registerCoverageFromEnvironment } from "./collector.ts";

const collector = registerCoverageFromEnvironment();
try {
  afterAll(() => {
    collector.flush();
  });
} catch (error) {
  if (
    !(error instanceof Error) ||
    error.message !==
      'Cannot use afterAll() outside of the test runner. Run "bun test" to run tests.'
  )
    throw error;
}
// Bun scripts flush on normal exit. bun:test relies on afterAll, since its exit
// callbacks are not reliable. Killed processes may have no capture.
process.once("exit", () => {
  collector.flush();
});
