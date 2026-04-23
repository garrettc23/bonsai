/**
 * Build analyzer inputs from shipped fixtures.
 *
 * Historically each script inlined `billPdfPath`, `eobPdfPath`, and
 * `billFixtureName`. After switching analyzer input to a `NormalizedBill`
 * + pre-loaded `GroundTruth`, the conversion is identical everywhere — so
 * it lives here.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBillFile, type NormalizedBill } from "./extract-bill.ts";
import { loadGroundTruth, type GroundTruth } from "./ground-truth.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "..", "fixtures");

export interface AnalyzeInput {
  /** Single file or ordered pages of one bill. */
  bill: NormalizedBill | NormalizedBill[];
  eob?: NormalizedBill;
  billGroundTruth: GroundTruth;
}

export async function loadFixtureAnalyzeInput(
  billFixtureName: string,
  eobFixtureName?: string,
): Promise<AnalyzeInput> {
  const billPath = join(FIXTURES_DIR, `${billFixtureName}.pdf`);
  const bill = await normalizeBillFile(billPath, `${billFixtureName}.pdf`);
  const billGroundTruth = loadGroundTruth(billFixtureName);
  let eob: NormalizedBill | undefined;
  if (eobFixtureName) {
    const eobPath = join(FIXTURES_DIR, `${eobFixtureName}.pdf`);
    eob = await normalizeBillFile(eobPath, `${eobFixtureName}.pdf`);
  }
  return { bill, eob, billGroundTruth };
}
