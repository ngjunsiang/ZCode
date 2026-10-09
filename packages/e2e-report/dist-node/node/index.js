import { readFileSync } from "node:fs";
import { resolve } from "node:path";
export const DEFAULT_E2E_REPORT_VIEWER_BASE_URL = "http://127.0.0.1:4173/";
export function readE2EReportSummary(summaryJsonPath) {
    return JSON.parse(readFileSync(summaryJsonPath, "utf-8"));
}
export function createE2EReportViewerUrl(options) {
    const baseUrl = options.baseUrl ??
        process.env.ZCODE_E2E_REPORT_VIEWER_BASE_URL ??
        DEFAULT_E2E_REPORT_VIEWER_BASE_URL;
    const url = new URL(baseUrl);
    url.searchParams.set("summary", toViteFsPath(options.summaryJsonPath));
    return url.toString();
}
function toViteFsPath(path) {
    const absolutePath = resolve(path).replace(/\\/gu, "/");
    return absolutePath.startsWith("/")
        ? `/@fs${absolutePath}`
        : `/@fs/${absolutePath}`;
}
//# sourceMappingURL=index.js.map