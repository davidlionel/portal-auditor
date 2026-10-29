import type { Playbook, Section, Step } from "./build";

// Lays the playbook out as a pdfmake document. Plain black and white:
// hierarchy comes from size, weight and rules, severity is spelled out, and
// the only colours are black and greys (a unit test checks), so it prints
// and photocopies cleanly.

export const INK = "#000000";
export const MUTED = "#555555";
export const RULE = "#999999";

// Characters the bundled Roboto font can draw. Anything else (arrows, most
// symbols, Japanese, Chinese, Korean...) prints as "?" and the section says
// so. A unit test renders all of these and checks each survives.
export const PRINTABLE =
  /[ -~ -¬®-´¶-ÿĀ-ſΑ-ΡΣ-Ωα-ωЀ-҂Ҋ-ӿ–—‘’“”•…€™≤≥]/u;

const UNPRINTABLE = new RegExp(`(?:(?!${PRINTABLE.source}).)+`, "gsu");

// Text with unprintable runs replaced by "?", and whether any were.
export function printable(text: string): { text: string; changed: boolean } {
  const replaced = text.replace(UNPRINTABLE, "?");
  return { text: replaced, changed: replaced !== text };
}

type Content = string | Record<string, unknown> | Content[];

// Every string in the document goes through here.
const t = (text: string) => printable(text).text;

const points = (n: number) => `+${n.toFixed(1)} pts`;
const score = (n: number | null) => (n === null ? "Not scored" : `${n} / 100`);

const heading = (text: string, style: "h1" | "h2" | "h3", extra: Record<string, unknown> = {}) => ({
  text: t(text),
  style,
  ...extra,
});

// A function, not a shared object: pdfmake changes the nodes it lays out.
const rule = () => ({ canvas: [{ type: "line", x1: 0, y1: 0, x2: 504, y2: 0, lineWidth: 0.75, lineColor: RULE }], margin: [0, 4, 0, 8] });

function stepItem(s: Step): Content {
  const text = s.general ? [{ text: "General guidance (not from HubSpot's documentation): ", italics: true }, t(s.text)] : t(s.text);
  return s.conditions?.length
    ? [{ text }, { ul: s.conditions.map((c) => ({ text: t(c), bold: true })), margin: [0, 2, 0, 2] }]
    : { text };
}

const sourceList = (urls: string[]) => ({
  stack: [
    { text: urls.length === 1 ? "Source" : "Sources", style: "label" },
    ...urls.map((url) => ({ text: url, link: url, style: "small" })),
  ],
  margin: [0, 6, 0, 0],
});

function sectionContent(s: Section): Content[] {
  const items = s.items.map(printable);
  const itemsChanged = items.some((i) => i.changed);
  return [
    {
      stack: [
        heading(`${s.number}. ${s.title}`, "h2"),
        {
          text: t(
            s.scored
              ? `${s.severity.toUpperCase()} severity · ${s.category} · ${points(s.points)} if fixed`
              : `${s.severity.toUpperCase()} confidence · ${s.category} · Not scored until confirmed`,
          ),
          style: "meta",
        },
      ],
      unbreakable: true,
      margin: [0, 14, 0, 4],
    },
    { text: [{ text: "What's wrong: ", bold: true }, t(`${s.rate}.`)] },
    { text: [{ text: "Why it matters: ", bold: true }, t(s.why)], margin: [0, 2, 0, 0] },
    heading("How to fix it in HubSpot", "h3"),
    { ol: s.steps.map(stepItem) },
    ...(s.prevent.length ? [heading("Stop it coming back", "h3"), { ul: s.prevent.map(stepItem) }] : []),
    ...(items.length
      ? [
          heading(s.category === "Properties" ? "Properties to fix" : "Items", "h3"),
          { ul: items.map((i) => i.text), style: "small" },
          ...(s.itemsNote ? [{ text: t(s.itemsNote), style: "small", margin: [0, 2, 0, 0] }] : []),
          ...(itemsChanged
            ? [{ text: "Some labels use characters this PDF can't show; they appear as ?. Check them in HubSpot.", style: "small", margin: [0, 2, 0, 0] }]
            : []),
        ]
      : []),
    // The CSV advice and the sources stay together on one page, so a
    // section's sources never land alone on the next.
    { stack: [heading("CSV", "h3"), { text: t(s.csv) }, sourceList(s.sources)], unbreakable: true },
    rule(),
  ];
}

function cover(p: Playbook): Content[] {
  return [
    { text: "Cleanup playbook", style: "title" },
    { text: t(p.portal), style: "lead" },
    { text: `Scanned ${p.scanDate}`, style: "lead" },
    ...(p.sample
      ? [{ text: "Sample: a scan of a HubSpot developer test portal with synthetic data.", italics: true, margin: [0, 4, 0, 0] }]
      : []),
    ...(p.incomplete
      ? [{ text: [{ text: "Incomplete: ", bold: true }, t(p.incomplete)], margin: [0, 6, 0, 0] }]
      : []),
    rule(),
    { text: [{ text: "Health score: ", style: "h2" }, { text: score(p.overall), style: "h1" }], margin: [0, 4, 0, 6] },
    {
      table: {
        widths: ["*", 90],
        body: [
          [{ text: "Category", bold: true }, { text: "Score", bold: true }],
          ...p.categories.map((c) => [c.category, score(c.score)]),
        ],
      },
      layout: "blackLines",
      margin: [0, 0, 0, 12],
    },
    heading("Top 5 fixes", "h2"),
    p.topFixes.length
      ? { ol: p.topFixes.map((f) => ({ text: [t(f.title), { text: `  ${points(f.points)}`, bold: true }] })) }
      : { text: "No problems found." },
    heading("How to use this playbook", "h2", { margin: [0, 14, 0, 4] }),
    {
      text: t(
        "Each numbered section below is one problem, biggest score gain first. It says what's wrong, why it matters, how to find and fix the records in HubSpot, and whether you need a CSV. Most problems need only a HubSpot filter. The CSVs come with this playbook in the ZIP download; Appendix A explains each one and Appendix B shows how to import one by Record ID. The auditor only reads your portal; every change here is one you make in HubSpot.",
      ),
    },
    { text: `HubSpot steps verified against HubSpot's documentation on ${p.verifiedOn}.`, bold: true, margin: [0, 10, 0, 0] },
    { text: "Each section ends with the pages it relies on. HubSpot changes its interface over time, so check a page if a step doesn't match.", style: "small" },
  ];
}

function appendix(p: Playbook): Content[] {
  return [
    heading("Appendix A: The CSV files", "h1", { pageBreak: "before" }),
    {
      text: "Built from the scan, with record IDs only: no names, emails, phone numbers or other record values. The import files in imports/ have one row per record, ready to import.",
      margin: [0, 0, 0, 6],
    },
    ...p.files.flatMap((file) => [
      { text: t(file.path), bold: true, margin: [0, 8, 0, 0] },
      { text: t(file.description), margin: [0, 0, 0, 4] },
      {
        table: {
          widths: [120, "*"],
          headerRows: 1,
          body: [
            [{ text: "Column", bold: true }, { text: "What it holds", bold: true }],
            ...file.columns.map((c) => [t(c.name), t(c.note)]),
          ],
        },
        layout: "blackLines",
        style: "small",
      },
    ]),
    heading("Appendix B: Importing a file by Record ID", "h1", { pageBreak: "before" }),
    {
      text: "Imports write to your portal, unlike the auditor, so try one on a test portal or sandbox first. Remove the segment or Cleanup reason property when the cleanup is done.",
      margin: [0, 0, 0, 6],
    },
    { ol: p.importSteps.map(stepItem) },
    sourceList(p.importSources),
  ];
}

// The pdfmake document definition: plain data, so tests can inspect it.
export function playbookDocument(p: Playbook): Record<string, unknown> {
  return {
    pageSize: "LETTER",
    pageMargins: [54, 54, 54, 60],
    info: { title: t(`Cleanup playbook: ${p.portal}`), creator: "Portal Health Auditor" },
    defaultStyle: { font: "Roboto", fontSize: 10, lineHeight: 1.25, color: INK },
    styles: {
      title: { fontSize: 24, bold: true, margin: [0, 0, 0, 6] },
      lead: { fontSize: 12 },
      h1: { fontSize: 16, bold: true, margin: [0, 0, 0, 6] },
      h2: { fontSize: 13, bold: true, margin: [0, 10, 0, 4] },
      h3: { fontSize: 10.5, bold: true, margin: [0, 8, 0, 2] },
      meta: { fontSize: 9, color: MUTED },
      label: { fontSize: 8.5, bold: true, color: MUTED },
      small: { fontSize: 8.5, color: MUTED },
    },
    footer: (page: number, pages: number) => ({
      text: t(`Cleanup playbook · ${p.portal} · Page ${page} of ${pages}`),
      style: "small",
      alignment: "center",
      margin: [0, 24, 0, 0],
    }),
    content: [...cover(p), { text: "", pageBreak: "after" }, ...p.sections.flatMap(sectionContent), ...appendix(p)],
  };
}

// Plain black table rules.
export const TABLE_LAYOUTS = {
  blackLines: {
    hLineWidth: () => 0.5,
    vLineWidth: () => 0.5,
    hLineColor: () => INK,
    vLineColor: () => INK,
    paddingLeft: () => 4,
    paddingRight: () => 4,
    paddingTop: () => 2,
    paddingBottom: () => 2,
  },
};

// pdfmake and its fonts (about 2 MB), loaded and set up once, on first use,
// so the page itself stays light.
let loaded: Promise<typeof import("pdfmake/build/pdfmake.js").default> | undefined;
export function loadPdfmake() {
  loaded ??= Promise.all([import("pdfmake/build/pdfmake.js"), import("pdfmake/build/vfs_fonts.js")]).then(
    ([{ default: pdfMake }, { default: vfs }]) => {
      pdfMake.addVirtualFileSystem(vfs);
      // Nothing in the playbook loads from a URL; refuse any that sneaks in.
      pdfMake.setUrlAccessPolicy(() => false);
      pdfMake.addTableLayouts(TABLE_LAYOUTS);
      return pdfMake;
    },
  );
  return loaded;
}

export async function renderPlaybookPdf(p: Playbook): Promise<Uint8Array> {
  const pdfMake = await loadPdfmake();
  const doc = pdfMake.createPdf(playbookDocument(p));
  return new Uint8Array(await (await doc.getBlob()).arrayBuffer());
}
