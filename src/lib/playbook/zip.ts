import { strToU8, zipSync, type Zippable } from "fflate";
import { playbookFileName, zipFileName } from "../csv";
import type { ScanReport } from "../scan";
import { buildPlaybook } from "./build";
import { exportFiles } from "./files";
import { renderPlaybookPdf } from "./pdf";

// Everything from one scan in one folder: the playbook PDF and every CSV,
// byte for byte what the individual download buttons give.
export async function buildZip(report: ScanReport, { sample = false }: { sample?: boolean } = {}): Promise<Uint8Array> {
  const folder = zipFileName(report).replace(/\.zip$/, "");
  const pdf = await renderPlaybookPdf(buildPlaybook(report, { sample }));
  // The PDF is already compressed, so it's stored as-is; the CSVs shrink well.
  const entries: Zippable = { [`${folder}/${playbookFileName(report)}`]: [pdf, { level: 0 }] };
  for (const file of exportFiles(report, { sample })) entries[`${folder}/${file.path}`] = strToU8(file.content);
  return zipSync(entries, { level: 6, mtime: new Date(report.scannedAt) });
}
