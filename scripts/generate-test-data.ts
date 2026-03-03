import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// --- Types ---

interface Patient {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender: string;
  context: string;
}

interface SyntheticCase {
  id: string;
  patient: Patient;
  templateId: string;
  transcript: string;
  expectedEntities: {
    drugs: string[];
    conditions: string[];
  };
}

// --- Config ---

const PATIENTS_PATH = resolve(ROOT, "../kasa_server/prisma/patients.json");
const OUTPUT_PATH = resolve(ROOT, "test-data/cases.json");
const TRANSCRIPTS_DIR = resolve(ROOT, "test-data/transcripts");
const TARGET_COUNT = parseInt(process.argv[2] || "25", 10);
const REGENERATE = process.argv.includes("--regenerate");

// Select patients with diverse conditions
function selectPatients(patients: Patient[], count: number): Patient[] {
  const step = Math.max(1, Math.floor(patients.length / count));
  const selected: Patient[] = [];
  for (let i = 0; i < patients.length && selected.length < count; i += step) {
    selected.push(patients[i]);
  }
  for (let i = 1; selected.length < count && i < patients.length; i++) {
    if (!selected.includes(patients[i])) {
      selected.push(patients[i]);
    }
  }
  return selected;
}

// Pick a template type based on patient context
function pickTemplate(patient: Patient): string {
  const ctx = patient.context.toLowerCase();
  if (ctx.includes("follow-up") || ctx.includes("regular") || ctx.includes("management")) {
    return "soap";
  }
  if (ctx.includes("initial") || ctx.includes("new patient") || ctx.includes("evaluation")) {
    return "hp";
  }
  if (ctx.includes("quarterly") || ctx.includes("monthly") || ctx.includes("annual")) {
    return "progress";
  }
  return "soap";
}

function makeId(patient: Patient, templateId: string): string {
  const name = `${patient.firstName}-${patient.lastName}`.toLowerCase().replace(/\s+/g, "-");
  return `${name}__${templateId}`;
}

async function generateTranscript(
  genai: GoogleGenAI,
  patient: Patient,
  templateId: string
): Promise<{ transcript: string; drugs: string[]; conditions: string[] }> {
  const systemPrompt = `You are a medical simulation expert. Generate a realistic doctor-patient encounter transcript for use in testing a medical documentation system.

Output ONLY valid JSON with this exact structure:
{
  "transcript": "the full transcript as a string",
  "drugs": ["list", "of", "medications", "mentioned"],
  "conditions": ["list", "of", "conditions", "mentioned"]
}

Guidelines for the transcript:
- Write a 300-800 word conversation between a doctor and patient
- Use realistic medical terminology, vital signs, and exam findings
- Include specific medication names and dosages where appropriate
- The conversation should be natural and include typical clinical dialogue
- Include the doctor's assessment and plan discussion
- The tone should match a real clinical encounter
- Use the patient's name, age, and gender naturally in the conversation`;

  const userPrompt = `Generate a ${templateId === "soap" ? "standard office visit" : templateId === "hp" ? "comprehensive initial evaluation" : "follow-up progress"} transcript for:

Patient: ${patient.firstName} ${patient.lastName}
DOB: ${patient.dateOfBirth} (${getAge(patient.dateOfBirth)} years old)
Gender: ${patient.gender}
Medical Context: ${patient.context}

Make the transcript realistic and consistent with this patient's medical context.`;

  const response = await genai.models.generateContent({
    model: "gemini-3-pro-preview",
    contents: userPrompt,
    config: {
      systemInstruction: systemPrompt,
      temperature: 0.8,
      maxOutputTokens: 4000,
      responseMimeType: "application/json",
    },
  });

  const text = response.text ?? "{}";
  return JSON.parse(text);
}

function getAge(dob: string): number {
  const birth = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  if (now.getMonth() < birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

// --- Main ---

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!project) {
    console.error("Error: GOOGLE_CLOUD_PROJECT is required in .env");
    process.exit(1);
  }

  // Resolve ~ in credentials path
  const resolvedCreds = credentials?.replace(/^~/, process.env.HOME ?? "");
  if (resolvedCreds) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = resolvedCreds;
  }

  const genai = new GoogleGenAI({
    vertexai: true,
    project,
    location: "global",
  });

  console.log(`Using Gemini 3 Pro Preview via Vertex AI (project: ${project})`);

  // Load existing cases if not regenerating
  let existingCases: SyntheticCase[] = [];
  if (!REGENERATE && existsSync(OUTPUT_PATH)) {
    existingCases = JSON.parse(readFileSync(OUTPUT_PATH, "utf-8"));
    console.log(`Found ${existingCases.length} existing cases.`);
  }

  const existingIds = new Set(existingCases.map((c) => c.id));

  // Load patients
  const allPatients: Patient[] = JSON.parse(readFileSync(PATIENTS_PATH, "utf-8"));
  console.log(`Loaded ${allPatients.length} patients from patients.json`);

  const selected = selectPatients(allPatients, TARGET_COUNT);
  console.log(`Selected ${selected.length} patients for test data generation`);

  // Ensure output directories exist
  if (!existsSync(dirname(OUTPUT_PATH))) mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  if (!existsSync(TRANSCRIPTS_DIR)) mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

  const cases: SyntheticCase[] = [...existingCases];
  let generated = 0;

  for (const patient of selected) {
    const templateId = pickTemplate(patient);
    const id = makeId(patient, templateId);

    if (existingIds.has(id)) {
      console.log(`  Skipping ${id} (already exists)`);
      continue;
    }

    console.log(`  Generating transcript for ${id}...`);

    try {
      const result = await generateTranscript(genai, patient, templateId);

      const syntheticCase: SyntheticCase = {
        id,
        patient,
        templateId,
        transcript: result.transcript,
        expectedEntities: {
          drugs: result.drugs,
          conditions: result.conditions,
        },
      };

      cases.push(syntheticCase);
      generated++;

      // Also write individual transcript file for Promptfoo file:// references
      writeFileSync(
        resolve(TRANSCRIPTS_DIR, `${id}.txt`),
        result.transcript,
        "utf-8"
      );

      // Save incrementally in case of interruption
      writeFileSync(OUTPUT_PATH, JSON.stringify(cases, null, 2), "utf-8");
    } catch (error) {
      console.error(`  Error generating ${id}:`, error);
    }
  }

  console.log(`\nDone! Generated ${generated} new cases (${cases.length} total).`);
  console.log(`Output: ${OUTPUT_PATH}`);
  console.log(`Transcripts: ${TRANSCRIPTS_DIR}/`);
}

main();
