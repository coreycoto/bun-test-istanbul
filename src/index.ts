export type { CoverageCapture, CoverageCollector } from "./collector.ts";
export {
  createCoverageCollector,
  registerCoverage,
  registerCoverageFromEnvironment,
} from "./collector.ts";
export type { Reporter, ReportOptions } from "./report.ts";
export { REPORTERS, reportCoverage } from "./report.ts";
export type {
  CoverageOptions,
  CoverageRun,
  RunManifest,
  SourceRecord,
} from "./run.ts";
export {
  MANIFEST_ENV,
  MANIFEST_HASH_ENV,
  prepareCoverage,
  readCoverageRun,
  verifySources,
} from "./run.ts";
