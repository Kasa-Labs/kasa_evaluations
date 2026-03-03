import Database from "better-sqlite3";
import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const REPORTS_DIR = resolve(ROOT, "output", "reports");

interface ComponentResult {
  assertion: { type: string; value: string };
  pass: boolean;
  score: number;
  reason: string;
}

interface EvalRow {
  model: string;
  test_desc: string;
  prompt_idx: number;
  score: number;
  success: number;
  components: string;
}

interface EvalInfo {
  id: string;
  created_at: number;
  result_count: number;
}

interface ModelInfo {
  label: string;
  params: string;
  quant: string;
  disk: string;
  ram: string;
}

const MODEL_SPECS: Record<string, ModelInfo> = {
  "Gemma 3n":     { label: "Gemma 3n",     params: "6.9B", quant: "Q4_K_M", disk: "7.5 GB", ram: "~10 GB" },
  "Phi-3 Mini":   { label: "Phi-3 Mini",   params: "3.8B", quant: "Q4_0",   disk: "2.2 GB", ram: "~4 GB" },
  "Llama 3.2":    { label: "Llama 3.2",    params: "3.2B", quant: "Q4_K_M", disk: "2.0 GB", ram: "~4 GB" },
  "Gemma 2B":     { label: "Gemma 2B",     params: "2.6B", quant: "Q4_0",   disk: "1.6 GB", ram: "~4 GB" },
  "Qwen 2":       { label: "Qwen 2",       params: "7.6B", quant: "Q4_0",   disk: "4.4 GB", ram: "~8 GB" },
  "MedGemma 4B":  { label: "MedGemma 4B",  params: "3.9B", quant: "Q4_K_M", disk: "2.5 GB", ram: "~4 GB" },
  "Gemini 3 Pro": { label: "Gemini 3 Pro", params: "—",    quant: "—",      disk: "Cloud",  ram: "Cloud" },
};

function getModelLabel(providerJson: string): string {
  if (providerJson.includes("gemma3n")) return "Gemma 3n";
  if (providerJson.includes("phi3")) return "Phi-3 Mini";
  if (providerJson.includes("llama3.2")) return "Llama 3.2";
  if (providerJson.includes("gemma2:2b")) return "Gemma 2B";
  if (providerJson.includes("qwen2")) return "Qwen 2";
  if (providerJson.includes("medgemma")) return "MedGemma 4B";
  if (providerJson.includes("gemini-3-pro")) return "Gemini 3 Pro";
  try {
    const parsed = JSON.parse(providerJson);
    return parsed.label || parsed.id || "Unknown";
  } catch {
    return "Unknown";
  }
}

function modelColumnHeader(name: string): string {
  const spec = MODEL_SPECS[name];
  if (!spec) return name;
  if (spec.disk === "Cloud") {
    return `${name}<br><span style="font-weight:400;font-size:0.65rem;color:#94a3b8">Cloud API</span>`;
  }
  return `${name}<br><span style="font-weight:400;font-size:0.65rem;color:#94a3b8">${spec.params} · ${spec.quant}<br>${spec.disk} disk · ${spec.ram} RAM</span>`;
}

function getRubricLabel(value: string): string {
  if (value.includes("accurate")) return "Accuracy";
  if (value.includes("complete")) return "Completeness";
  if (value.includes("marks MEDICATIONS") || value.includes("marks clinical entities")) return "Drug Marking";
  if (value.includes("marks CONDITIONS")) return "Condition Marking";
  if (value.includes("NOT hallucinate")) return "No Hallucination";
  if (value.includes("formatting")) return "Formatting";
  if (value.includes("professionally")) return "Clinical Quality";
  return value.slice(0, 30) + "…";
}

function scoreColor(score: number): string {
  if (score >= 0.9) return "#22c55e";   // green
  if (score >= 0.7) return "#eab308";   // yellow
  if (score >= 0.5) return "#f97316";   // orange
  return "#ef4444";                      // red
}

function scoreBg(score: number): string {
  if (score >= 0.9) return "#f0fdf4";
  if (score >= 0.7) return "#fefce8";
  if (score >= 0.5) return "#fff7ed";
  return "#fef2f2";
}

function passRateBadge(pass: number, total: number): string {
  const pct = total > 0 ? (pass / total) * 100 : 0;
  const color = scoreColor(pct / 100);
  return `<span style="color:${color};font-weight:600">${pass}/${total}</span>`;
}

function generateReport(db: Database.Database, evalIds: string[], title: string): string {
  const placeholders = evalIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT
      provider as model,
      json_extract(test_case, '$.description') as test_desc,
      prompt_idx,
      score,
      success,
      json_extract(grading_result, '$.componentResults') as components
    FROM eval_results
    WHERE eval_id IN (${placeholders})
    ORDER BY test_desc, prompt_idx
  `).all(...evalIds) as EvalRow[];

  if (rows.length === 0) return "";

  // Extract unique models, test cases, and prompt indices
  const models = [...new Set(rows.map(r => getModelLabel(r.model)))];
  const testCases = [...new Set(rows.map(r => r.test_desc))];

  // Build per-rubric breakdown: model -> rubric -> { pass, total, avgScore }
  const rubricStats: Record<string, Record<string, { pass: number; total: number; scores: number[] }>> = {};
  // Build per-test breakdown: test -> model -> { score, components }
  const testStats: Record<string, Record<string, { scores: number[]; components: ComponentResult[][] }>> = {};

  for (const row of rows) {
    const model = getModelLabel(row.model);
    let components: ComponentResult[] = [];
    try {
      components = JSON.parse(row.components || "[]");
    } catch { continue; }

    // Rubric-level stats
    if (!rubricStats[model]) rubricStats[model] = {};
    for (const comp of components) {
      const label = getRubricLabel(comp.assertion.value);
      if (!rubricStats[model][label]) rubricStats[model][label] = { pass: 0, total: 0, scores: [] };
      rubricStats[model][label].total++;
      if (comp.pass) rubricStats[model][label].pass++;
      rubricStats[model][label].scores.push(comp.score);
    }

    // Test-level stats
    const testKey = row.test_desc;
    if (!testStats[testKey]) testStats[testKey] = {};
    if (!testStats[testKey][model]) testStats[testKey][model] = { scores: [], components: [] };
    testStats[testKey][model].scores.push(row.score);
    testStats[testKey][model].components.push(components);
  }

  const rubricLabels = [...new Set(
    Object.values(rubricStats).flatMap(m => Object.keys(m))
  )];

  // Compute overall model scores
  const modelOverall: Record<string, { pass: number; total: number; avgScore: number }> = {};
  for (const model of models) {
    const modelRows = rows.filter(r => getModelLabel(r.model) === model);
    const totalPass = modelRows.filter(r => r.success === 1).length;
    const avgScore = modelRows.reduce((s, r) => s + r.score, 0) / modelRows.length;
    modelOverall[model] = { pass: totalPass, total: modelRows.length, avgScore };
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Eval Report — ${title}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #f8fafc; color: #1e293b; padding: 2rem; }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  .meta { color: #64748b; font-size: 0.875rem; margin-bottom: 1.5rem; }
  h2 { font-size: 1.1rem; margin: 2rem 0 0.75rem; color: #334155; }
  .table-wrap { overflow-x: auto; margin-bottom: 2rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.8rem; }
  th, td { padding: 0.5rem 0.75rem; border: 1px solid #e2e8f0; text-align: center; white-space: nowrap; }
  th { background: #f1f5f9; font-weight: 600; color: #475569; position: sticky; top: 0; white-space: normal; min-width: 100px; vertical-align: bottom; line-height: 1.4; }
  td.label { text-align: left; font-weight: 500; white-space: normal; min-width: 180px; }
  .score-cell { font-weight: 600; font-size: 0.85rem; }
  .overall-row td { border-top: 2px solid #94a3b8; font-weight: 700; }
  .legend { display: flex; gap: 1.5rem; margin: 1rem 0; font-size: 0.8rem; color: #64748b; }
  .legend-item { display: flex; align-items: center; gap: 0.35rem; }
  .legend-swatch { width: 14px; height: 14px; border-radius: 3px; border: 1px solid #e2e8f0; }
  .footer { margin-top: 2rem; font-size: 0.75rem; color: #94a3b8; }
</style>
</head>
<body>
<h1>Kasa Eval Report</h1>
<p class="meta">${title} &nbsp;·&nbsp; ${rows.length} results across ${models.length} models${evalIds.length > 1 ? ` (merged from ${evalIds.length} eval runs)` : ""}</p>

<div class="legend">
  <div class="legend-item"><div class="legend-swatch" style="background:#f0fdf4;border-color:#22c55e"></div> ≥90%</div>
  <div class="legend-item"><div class="legend-swatch" style="background:#fefce8;border-color:#eab308"></div> 70–89%</div>
  <div class="legend-item"><div class="legend-swatch" style="background:#fff7ed;border-color:#f97316"></div> 50–69%</div>
  <div class="legend-item"><div class="legend-swatch" style="background:#fef2f2;border-color:#ef4444"></div> &lt;50%</div>
</div>

<h2>Rubric Breakdown</h2>
<div class="table-wrap">
<table>
<thead>
<tr><th>Rubric</th>${models.map(m => `<th>${modelColumnHeader(m)}</th>`).join("")}</tr>
</thead>
<tbody>
${rubricLabels.map(rubric => {
  const cells = models.map(model => {
    const stats = rubricStats[model]?.[rubric];
    if (!stats || stats.total === 0) return `<td>—</td>`;
    const avg = stats.scores.reduce((a, b) => a + b, 0) / stats.scores.length;
    const pct = Math.round(avg * 100);
    return `<td class="score-cell" style="background:${scoreBg(avg)};color:${scoreColor(avg)}">${pct}% ${passRateBadge(stats.pass, stats.total)}</td>`;
  }).join("");
  return `<tr><td class="label">${rubric}</td>${cells}</tr>`;
}).join("\n")}
<tr class="overall-row">
  <td class="label">Overall</td>
  ${models.map(model => {
    const o = modelOverall[model];
    const pct = Math.round(o.avgScore * 100);
    return `<td class="score-cell" style="background:${scoreBg(o.avgScore)};color:${scoreColor(o.avgScore)}">${pct}%</td>`;
  }).join("")}
</tr>
</tbody>
</table>
</div>

<h2>Per-Patient Results</h2>
<div class="table-wrap">
<table>
<thead>
<tr><th>Patient</th>${models.map(m => `<th>${modelColumnHeader(m)}</th>`).join("")}</tr>
</thead>
<tbody>
${testCases.map(test => {
  const cells = models.map(model => {
    const stats = testStats[test]?.[model];
    if (!stats || stats.scores.length === 0) return `<td>—</td>`;
    const avg = stats.scores.reduce((a, b) => a + b, 0) / stats.scores.length;
    const pct = Math.round(avg * 100);
    // Count passed assertions across all prompt variants
    const allComps = stats.components.flat();
    const passCount = allComps.filter(c => c.pass).length;
    return `<td class="score-cell" style="background:${scoreBg(avg)};color:${scoreColor(avg)}">${pct}% <span style="font-weight:400;font-size:0.75rem;color:#64748b">(${passCount}/${allComps.length})</span></td>`;
  }).join("");
  return `<tr><td class="label">${test}</td>${cells}</tr>`;
}).join("\n")}
</tbody>
</table>
</div>

<div class="footer">Generated by kasa_eval/scripts/generate-html-reports.ts</div>
</body>
</html>`;
}

function main() {
  const dbPath = join(homedir(), ".promptfoo", "promptfoo.db");
  const db = new Database(dbPath, { readonly: true });

  const evals = db.prepare(`
    SELECT e.id, e.created_at, COUNT(r.id) as result_count
    FROM evals e
    JOIN eval_results r ON e.id = r.eval_id
    GROUP BY e.id
    HAVING result_count >= 10
    ORDER BY e.created_at DESC
  `).all() as EvalInfo[];

  console.log(`Found ${evals.length} eval runs with ≥10 results`);

  mkdirSync(REPORTS_DIR, { recursive: true });

  // --- Individual reports ---
  for (const ev of evals) {
    const date = new Date(ev.created_at).toLocaleString("en-AU", {
      timeZone: "Australia/Sydney",
      dateStyle: "medium",
      timeStyle: "short",
    });
    const html = generateReport(db, [ev.id], date);
    if (!html) continue;

    const dateStr = new Date(ev.created_at).toISOString().slice(0, 16).replace(/[T:]/g, "-");
    const filename = `eval-${dateStr}.html`;
    const outPath = resolve(REPORTS_DIR, filename);
    writeFileSync(outPath, html, "utf-8");
    console.log(`  → ${filename} (${ev.result_count} results)`);
  }

  // --- Combined "latest" report ---
  // Find the most recent large eval (anchor), then merge in any runs created after it.
  // This lets you run a big eval, then add individual models later and see them together.
  if (evals.length >= 2) {
    // Sort by result count DESC to find the anchor (biggest recent run)
    const sortedBySize = [...evals].sort((a, b) => b.result_count - a.result_count);
    const anchor = sortedBySize[0];

    // Collect the anchor + any evals created on or after the anchor's timestamp
    const mergedIds = evals
      .filter(ev => ev.created_at >= anchor.created_at)
      .map(ev => ev.id);

    // Only generate combined report if there are runs beyond the anchor
    if (mergedIds.length > 1) {
      const totalResults = evals
        .filter(ev => mergedIds.includes(ev.id))
        .reduce((sum, ev) => sum + ev.result_count, 0);

      const anchorDate = new Date(anchor.created_at).toLocaleString("en-AU", {
        timeZone: "Australia/Sydney",
        dateStyle: "medium",
        timeStyle: "short",
      });

      const html = generateReport(db, mergedIds, `Combined — ${anchorDate} + ${mergedIds.length - 1} follow-up run(s)`);
      if (html) {
        const outPath = resolve(REPORTS_DIR, "eval-latest-combined.html");
        writeFileSync(outPath, html, "utf-8");
        console.log(`  → eval-latest-combined.html (${totalResults} results from ${mergedIds.length} runs)`);
      }
    }
  }

  db.close();
  console.log(`\nReports written to ${REPORTS_DIR}`);
}

main();
