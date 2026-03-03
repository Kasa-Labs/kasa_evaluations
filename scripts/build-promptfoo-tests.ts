import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

interface SyntheticCase {
  id: string;
  patient: {
    firstName: string;
    lastName: string;
    context: string;
  };
  templateId: string;
  transcript: string;
  expectedEntities: {
    drugs: string[];
    conditions: string[];
  };
}

function buildTestEntry(c: SyntheticCase): object {
  const drugs = c.expectedEntities.drugs.join(", ") || "none expected";
  const conditions = c.expectedEntities.conditions.join(", ") || "none expected";

  return {
    description: `${c.patient.firstName} ${c.patient.lastName} (${c.templateId})`,
    vars: {
      transcript: `file://test-data/transcripts/${c.id}.txt`,
      noteTemplate: `file://templates/${c.templateId}.txt`,
      context: c.patient.context,
    },
    assert: [
      {
        type: "llm-rubric",
        value: [
          "The clinical note is accurate: it contains ONLY information that was explicitly stated in the transcription.",
          "There are no fabricated or assumed clinical details. Every fact in the note can be traced back to something said in the encounter.",
          "IMPORTANT: The note uses double-curly-brace tags like {{drug:metformin}} and {{condition:hypertension}} to mark clinical entities. These are INTENTIONAL markup annotations, NOT unfilled placeholders or templates. They should be treated as equivalent to the entity name itself (e.g. {{drug:metformin}} simply means 'metformin'). Do NOT penalize the note for using these tags.",
        ].join("\n"),
      },
      {
        type: "llm-rubric",
        value: [
          "The clinical note is complete: it captures all significant topics, symptoms, findings, medications, and plans discussed in the transcription.",
          "No major discussion points from the encounter are missing from the note.",
        ].join("\n"),
      },
      {
        type: "llm-rubric",
        value: [
          "The clinical note correctly marks MEDICATIONS using double-curly-brace tags.",
          "Medications should be wrapped like this: two opening braces + drug:name + two closing braces (e.g. the text metformin becomes two opening braces then drug:metformin then two closing braces).",
          "Only the FIRST occurrence of each medication should be marked; subsequent mentions should be plain text.",
          `Expected medications to find marked: ${drugs}.`,
          "Minor spelling or capitalization differences (e.g. 'metformin' vs 'Metformin') are acceptable. A medication mentioned in the transcript that also appears in the note counts as marked if it has the correct tag format, even if the exact name differs slightly.",
        ].join("\n"),
      },
      {
        type: "llm-rubric",
        value: [
          "The clinical note correctly marks CONDITIONS using double-curly-brace tags.",
          "Conditions should be wrapped like this: two opening braces + condition:name + two closing braces (e.g. the text hypertension becomes two opening braces then condition:hypertension then two closing braces).",
          "Only the FIRST occurrence of each condition should be marked; subsequent mentions should be plain text.",
          `Expected conditions to find marked: ${conditions}.`,
          "Acceptable synonyms or abbreviations count as correct (e.g. 'diabetes' for 'Type 2 diabetes', 'HTN' for 'hypertension'). A condition only fails if it is completely absent from the note AND was clearly discussed in the transcript. Conditions that were only implied or tangentially mentioned may be omitted without penalty.",
        ].join("\n"),
      },
      {
        type: "llm-rubric",
        value: [
          "The clinical note does NOT hallucinate: it does not add clinical information that was not present in the transcription.",
          "There are no invented vital signs, medications, diagnoses, exam findings, or lab results that were not explicitly mentioned in the encounter.",
          "IMPORTANT: The note uses double-curly-brace tags like {{drug:metformin}} and {{condition:hypertension}} to mark clinical entities. These are INTENTIONAL markup annotations, NOT hallucinated content. Do NOT penalize the note for using these tags.",
        ].join("\n"),
      },
      {
        type: "llm-rubric",
        value: [
          "The clinical note uses correct formatting: section headers use **bold text** (not # markdown headings).",
          "Lists use bullet points or numbered items where appropriate. The overall structure follows the provided template.",
        ].join("\n"),
      },
      {
        type: "llm-rubric",
        value: [
          "The clinical note is professionally written with appropriate medical terminology.",
          "It reads like a real clinical note suitable for a medical record — not like a chatbot response or casual summary.",
        ].join("\n"),
      },
    ],
  };
}

function main() {
  const casesPath = resolve(ROOT, "test-data/cases.json");
  const cases: SyntheticCase[] = JSON.parse(readFileSync(casesPath, "utf-8"));
  console.log(`Loaded ${cases.length} test cases`);

  const tests = cases.map(buildTestEntry);

  // Write as a separate tests file that promptfooconfig.yaml can reference
  const testsPath = resolve(ROOT, "tests.yaml");

  // Build YAML manually to avoid needing a yaml library
  let yaml = "# Auto-generated by build-promptfoo-tests.ts\n";
  yaml += "# Do not edit manually — re-run: npx tsx scripts/build-promptfoo-tests.ts\n\n";
  yaml += yamlStringify(tests);

  writeFileSync(testsPath, yaml, "utf-8");
  console.log(`Written ${tests.length} test entries to ${testsPath}`);
}

// Minimal YAML serializer for our specific structure
function yamlStringify(tests: object[]): string {
  const lines: string[] = [];

  for (const test of tests as any[]) {
    lines.push(`- description: ${quote(test.description)}`);
    lines.push(`  vars:`);
    for (const [key, value] of Object.entries(test.vars as Record<string, string>)) {
      lines.push(`    ${key}: ${quote(value)}`);
    }
    lines.push(`  assert:`);
    for (const assertion of test.assert) {
      lines.push(`    - type: ${assertion.type}`);
      lines.push(`      value: |`);
      for (const line of assertion.value.split("\n")) {
        // Escape {{...}} for Nunjucks: {{foo}} → {{ "{{foo}}" }}
        const escaped = line.replace(/\{\{([^}]+)\}\}/g, '{{ "{{$1}}" }}');
        lines.push(`        ${escaped}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function quote(s: string): string {
  // Don't quote file:// references — Promptfoo needs them unquoted to resolve as file paths
  if (s.startsWith("file://")) {
    return s;
  }
  if (s.includes(":") || s.includes("#") || s.includes("'") || s.includes('"') || s.includes("{") || s.includes("}")) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

main();
