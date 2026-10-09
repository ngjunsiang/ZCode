import type { CreateE2EReportViewerUrlOptions, E2EReportSummary } from "../shared/types.js";
export type { ContainerSampleSummary, CreateE2EReportViewerUrlOptions, E2EReportSummary, NumericStats, ProcessSampleSummary, TestResultSummary, } from "../shared/types.js";
export declare const DEFAULT_E2E_REPORT_VIEWER_BASE_URL = "http://127.0.0.1:4173/";
export declare function readE2EReportSummary(summaryJsonPath: string): E2EReportSummary;
export declare function createE2EReportViewerUrl(options: CreateE2EReportViewerUrlOptions): string;
//# sourceMappingURL=index.d.ts.map