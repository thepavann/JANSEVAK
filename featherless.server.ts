/**
 * Featherless.ai integration — server only.
 * The API key is read inside handlers and never reaches the browser.
 */

import type { ExposureLevel, Severity } from "./civic";
import { ISSUE_TYPES } from "./civic";

const FEATHERLESS_URL = "https://api.featherless.ai/v1/chat/completions";

/**
 * Open (non-gated) Featherless models. Gated models such as
 * meta-llama/* require a HuggingFace org link and answer 403
 * `model_gated_needs_oauth`, so they are never used as defaults.
 */
const TEXT_MODELS = ["Qwen/Qwen2.5-7B-Instruct", "Qwen/Qwen3-8B", "Qwen/Qwen2.5-72B-Instruct"];
const VISION_MODELS = ["Qwen/Qwen2.5-VL-7B-Instruct", "Qwen/Qwen3-VL-8B-Instruct"];

function textModels(): string[] {
  const override = process.env["FEATHERLESS_MODEL"];
  return override ? [override, ...TEXT_MODELS.filter((m) => m !== override)] : TEXT_MODELS;
}

function visionModels(): string[] {
  const override = process.env["FEATHERLESS_VISION_MODEL"];
  return override ? [override, ...VISION_MODELS.filter((m) => m !== override)] : VISION_MODELS;
}

export type CivicAiResult = {
  issue_type: string;
  severity: Severity;
  confidence: number;
  traffic_exposure: ExposureLevel;
  pedestrian_exposure: ExposureLevel;
  sensitive_location: ExposureLevel;
  sensitive_location_note: string | null;
  evidence: string[];
  observations: string[];
  provided_facts: string[];
  inferences: string[];
  reasoning: string;
  recommended_action: string;
  related_issue: boolean;
  related_report_ids: string[];
  root_cause_hypothesis: string | null;
  cluster_confidence: number | null;
  model: string;
};

const SYSTEM_PROMPT = `You are CIVICLENS, a civic intelligence analysis engine for a municipal operations team.

You analyse citizen-submitted civic evidence (photo, description, location context) and return STRICT JSON only.

HARD RULES — these define the product's trust model:
1. "observations" may ONLY describe what is visible in the supplied image. If no image was supplied, "observations" MUST be an empty array. Phrase them cautiously ("Image appears to show ...").
2. "provided_facts" may ONLY restate what the citizen explicitly wrote. Never add facts they did not state.
3. "inferences" are your reasoning ON TOP of observations and provided facts. Phrase them as possibilities ("may", "likely").
4. Never invent street names, institutions, counts, dates or authorities. If something is unknown, omit it.
5. Do NOT output any priority number or score. Scoring is performed by the application, not by you.
6. Output raw JSON. No markdown fences, no commentary.

Return exactly this shape:
{
  "issue_type": one of ${ISSUE_TYPES.join(" | ")},
  "severity": "low" | "medium" | "high" | "critical",
  "confidence": number between 0 and 1,
  "traffic_exposure": "none" | "low" | "medium" | "high",
  "pedestrian_exposure": "none" | "low" | "medium" | "high",
  "sensitive_location": "none" | "low" | "medium" | "high",
  "sensitive_location_note": string | null,
  "evidence": string[] (3-6 short factual bullets),
  "observations": string[],
  "provided_facts": string[],
  "inferences": string[],
  "reasoning": string (2-3 sentences),
  "recommended_action": string (one concrete municipal next step),
  "related_issue": boolean (true only if a supplied nearby report likely describes the SAME physical problem),
  "related_report_ids": string[] (ids of supplied nearby reports describing the same problem; [] if none),
  "root_cause_hypothesis": string | null (a possible shared underlying civic problem, or null),
  "cluster_confidence": number between 0 and 1 or null
}`;

type NearbyReport = {
  id: string;
  issue_type: string;
  description: string;
  distance_m: number;
  severity: string;
};

export type AnalyzeInput = {
  description: string;
  imageDataUrl?: string | null;
  latitude: number;
  longitude: number;
  language?: string;
  nearby?: NearbyReport[];
};

function asArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string" && x.trim().length > 0).slice(0, 8);
}

const LEVELS = ["none", "low", "medium", "high"];

function asLevel(v: unknown, fallback: ExposureLevel): ExposureLevel {
  return (typeof v === "string" && LEVELS.includes(v) ? v : fallback) as ExposureLevel;
}

function asSeverity(v: unknown): Severity {
  const ok = ["low", "medium", "high", "critical"];
  return (typeof v === "string" && ok.includes(v) ? v : "medium") as Severity;
}

/** Validates the model output before anything is persisted. */
export function validateAiResult(raw: unknown, model: string, hasImage: boolean): CivicAiResult {
  if (!raw || typeof raw !== "object") throw new Error("AI response was not an object");
  const r = raw as Record<string, unknown>;
  const issue = typeof r["issue_type"] === "string" ? r["issue_type"].toLowerCase().trim() : "other";
  const confidence =
    typeof r["confidence"] === "number" && r["confidence"] >= 0 && r["confidence"] <= 1
      ? Number(r["confidence"].toFixed(3))
      : 0.7;
  const recommended =
    typeof r["recommended_action"] === "string" && r["recommended_action"].trim().length > 4
      ? r["recommended_action"].trim()
      : "Field inspection to confirm the reported condition.";

  return {
    issue_type: (ISSUE_TYPES as readonly string[]).includes(issue) ? issue : "other",
    severity: asSeverity(r["severity"]),
    confidence,
    traffic_exposure: asLevel(r["traffic_exposure"], "medium"),
    pedestrian_exposure: asLevel(r["pedestrian_exposure"], "medium"),
    sensitive_location: asLevel(r["sensitive_location"], "none"),
    sensitive_location_note:
      typeof r["sensitive_location_note"] === "string" ? r["sensitive_location_note"] : null,
    evidence: asArray(r["evidence"]),
    // Trust model enforced in code: no image => no visual observations, ever.
    observations: hasImage ? asArray(r["observations"]) : [],
    provided_facts: asArray(r["provided_facts"]),
    inferences: asArray(r["inferences"]),
    reasoning: typeof r["reasoning"] === "string" ? r["reasoning"].trim() : "",
    recommended_action: recommended,
    related_issue: r["related_issue"] === true,
    related_report_ids: asArray(r["related_report_ids"]),
    root_cause_hypothesis:
      typeof r["root_cause_hypothesis"] === "string" && r["root_cause_hypothesis"].trim()
        ? r["root_cause_hypothesis"].trim()
        : null,
    cluster_confidence:
      typeof r["cluster_confidence"] === "number"
        ? Number(Math.min(1, Math.max(0, r["cluster_confidence"])).toFixed(3))
        : null,
    model,
  };
}

function extractJson(text: string): unknown {
  const cleaned = text
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("AI response did not contain JSON");
  }
}

async function callFeatherless(
  apiKey: string,
  model: string,
  messages: unknown[],
): Promise<string> {
  const res = await fetch(FEATHERLESS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: 900,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    throw new Error(`Featherless request failed (${res.status}): ${detail}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("Featherless returned an empty completion");
  return content;
}

function buildUserPrompt(input: AnalyzeInput): string {
  const nearby = (input.nearby ?? [])
    .map(
      (n) =>
        `- id=${n.id} | ${n.issue_type} | severity=${n.severity} | ${n.distance_m}m away | "${n.description.slice(0, 180)}"`,
    )
    .join("\n");

  return [
    `CITIZEN DESCRIPTION (language=${input.language ?? "en"}): "${input.description}"`,
    `LOCATION: lat ${input.latitude.toFixed(5)}, lng ${input.longitude.toFixed(5)}`,
    input.imageDataUrl
      ? "AN IMAGE OF THE SITE IS ATTACHED. Base every entry in observations on it."
      : "NO IMAGE WAS SUPPLIED. observations MUST be [].",
    nearby
      ? `NEARBY EXISTING REPORTS (for duplicate / cluster reasoning):\n${nearby}`
      : "NEARBY EXISTING REPORTS: none within the search radius.",
    "Analyse this civic evidence and return the JSON object.",
  ].join("\n\n");
}

/**
 * Runs the real Featherless analysis. Tries a vision-capable model when an
 * image is present, then falls back to the text model (image dropped, so
 * observations stay empty — we never claim to have seen what we did not).
 */
export async function analyzeCivicEvidence(input: AnalyzeInput): Promise<CivicAiResult> {
  const apiKey = process.env["FEATHERLESS_API_KEY"];
  if (!apiKey) throw new Error("FEATHERLESS_API_KEY is not configured");

  const prompt = buildUserPrompt(input);

  const attempts: { model: string; withImage: boolean }[] = [
    ...(input.imageDataUrl ? visionModels().map((model) => ({ model, withImage: true })) : []),
    ...textModels().map((model) => ({ model, withImage: false })),
  ];

  let lastError: unknown;
  for (const attempt of attempts) {
    const userContent = attempt.withImage
      ? [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: input.imageDataUrl } },
        ]
      : prompt;
    try {
      const content = await callFeatherless(apiKey, attempt.model, [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ]);
      return validateAiResult(extractJson(content), attempt.model, attempt.withImage);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Featherless analysis failed");
}

/** Semantic cluster reasoning over a set of nearby reports. */
export async function reasonAboutCluster(
  reports: { id: string; issue_type: string; description: string; distance_m: number }[],
): Promise<{ root_cause: string; confidence: number; summary: string; member_ids: string[] } | null> {
  const apiKey = process.env["FEATHERLESS_API_KEY"];
  if (!apiKey || reports.length < 2) return null;

  const messages = [
    {
      role: "system",
      content:
        'You are CIVICLENS cluster reasoning. Given nearby civic reports, decide whether they plausibly share ONE underlying civic problem. Do not force unrelated reports together and never group reports only because the issue type matches. Return strict JSON: {"related": boolean, "root_cause": string, "confidence": number 0-1, "summary": string, "member_ids": string[]}. No markdown.',
    },
    {
      role: "user",
      content: reports
        .map((r) => `- id=${r.id} | ${r.issue_type} | ${r.distance_m}m | "${r.description.slice(0, 180)}"`)
        .join("\n"),
    },
  ];

  let content: string | null = null;
  let lastError: unknown;
  for (const model of textModels()) {
    try {
      content = await callFeatherless(apiKey, model, messages);
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (content === null) throw lastError instanceof Error ? lastError : new Error("Featherless analysis failed");

  const raw = extractJson(content) as Record<string, unknown>;
  if (raw["related"] !== true) return null;
  return {
    root_cause: typeof raw["root_cause"] === "string" ? raw["root_cause"] : "Shared underlying civic problem",
    confidence:
      typeof raw["confidence"] === "number" ? Number(Math.min(1, Math.max(0, raw["confidence"])).toFixed(3)) : 0.75,
    summary: typeof raw["summary"] === "string" ? raw["summary"] : "",
    member_ids: asArray(raw["member_ids"]),
  };
}
