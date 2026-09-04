/**
 * CIVICLENS deterministic civic intelligence core.
 *
 * The AI model extracts qualitative signals from evidence.
 * THIS file — application code — owns the final numbers.
 * The LLM never chooses a priority score.
 */

export type Severity = "low" | "medium" | "high" | "critical";
export type ExposureLevel = "none" | "low" | "medium" | "high";
export type IssueStatus = "open" | "in_review" | "in_progress" | "resolved";

export const ISSUE_TYPES = [
  "pothole",
  "drainage",
  "garbage",
  "streetlight",
  "traffic_signal",
  "water_leakage",
  "damaged_road",
  "other",
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const ISSUE_LABELS: Record<string, string> = {
  pothole: "Pothole",
  drainage: "Drainage",
  garbage: "Garbage accumulation",
  streetlight: "Broken streetlight",
  traffic_signal: "Traffic signal",
  water_leakage: "Water leakage",
  damaged_road: "Damaged road",
  other: "Other civic issue",
};

export const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  in_review: "In review",
  in_progress: "In progress",
  resolved: "Resolved",
};

/** Configurable civic impact weights (max contribution per factor). */
export const SCORE_WEIGHTS = {
  severity: 25,
  traffic: 23,
  pedestrian: 18,
  sensitive: 15,
  related: 13,
} as const;

export const FACTOR_LABELS: Record<keyof typeof SCORE_WEIGHTS, string> = {
  severity: "Issue severity",
  traffic: "Traffic exposure",
  pedestrian: "Pedestrian exposure",
  sensitive: "Sensitive location",
  related: "Related reports",
};

const SEVERITY_FACTOR: Record<Severity, number> = {
  low: 0.34,
  medium: 0.64,
  high: 1,
  critical: 1,
};

const EXPOSURE_FACTOR: Record<ExposureLevel, number> = {
  none: 0,
  low: 0.4,
  medium: 0.7,
  high: 1,
};

export type ScoreBreakdown = {
  severity: number;
  traffic: number;
  pedestrian: number;
  sensitive: number;
  related: number;
};

export type ScoreInput = {
  severity: Severity;
  traffic_exposure: ExposureLevel;
  pedestrian_exposure: ExposureLevel;
  sensitive_location: ExposureLevel;
  related_reports: number;
};

const clamp = (n: number, min = 0, max = 100) => Math.min(max, Math.max(min, n));

function relatedFactor(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 0.38;
  if (count === 2) return 0.62;
  if (count === 3) return 0.85;
  return 1;
}

export function computeCivicImpact(input: ScoreInput): {
  score: number;
  breakdown: ScoreBreakdown;
} {
  const breakdown: ScoreBreakdown = {
    severity: Math.round(SCORE_WEIGHTS.severity * (SEVERITY_FACTOR[input.severity] ?? 0.6)),
    traffic: Math.round(SCORE_WEIGHTS.traffic * (EXPOSURE_FACTOR[input.traffic_exposure] ?? 0.4)),
    pedestrian: Math.round(
      SCORE_WEIGHTS.pedestrian * (EXPOSURE_FACTOR[input.pedestrian_exposure] ?? 0.4),
    ),
    sensitive: Math.round(
      SCORE_WEIGHTS.sensitive * (EXPOSURE_FACTOR[input.sensitive_location] ?? 0),
    ),
    related: Math.round(SCORE_WEIGHTS.related * relatedFactor(input.related_reports)),
  };
  const score = clamp(
    breakdown.severity +
      breakdown.traffic +
      breakdown.pedestrian +
      breakdown.sensitive +
      breakdown.related,
  );
  return { score, breakdown };
}

/** Plain-language explanation of a deterministic score. */
export function explainPriority(
  breakdown: ScoreBreakdown,
  ctx: { severity: Severity; related: number; sensitive: boolean },
): string {
  const drivers: string[] = [];
  if (breakdown.severity >= SCORE_WEIGHTS.severity * 0.8) drivers.push("its assessed severity");
  if (breakdown.traffic >= SCORE_WEIGHTS.traffic * 0.65) drivers.push("high traffic exposure");
  if (breakdown.pedestrian >= SCORE_WEIGHTS.pedestrian * 0.65)
    drivers.push("pedestrian exposure");
  if (ctx.sensitive) drivers.push("proximity to a sensitive location");
  if (ctx.related >= 2) drivers.push(`${ctx.related} related citizen reports`);
  if (drivers.length === 0) drivers.push("limited public exposure at this location");
  const list =
    drivers.length > 1
      ? `${drivers.slice(0, -1).join(", ")} and ${drivers[drivers.length - 1]}`
      : drivers[0];
  return `This issue is ranked on ${list}.`;
}

/** Metres between two coordinates (haversine). */
export function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** Cheap lexical similarity used alongside AI semantic judgement. */
export function textSimilarity(a: string, b: string): number {
  const norm = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
  const sa = norm(a);
  const sb = norm(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter += 1;
  return inter / Math.min(sa.size, sb.size);
}

export function severityRank(s: string): number {
  return { low: 1, medium: 2, high: 3, critical: 4 }[s] ?? 2;
}

export function severityToken(s: string): string {
  return (
    { low: "low", medium: "medium", high: "high", critical: "critical" }[s] ?? "medium"
  );
}

/** City health: derived from the live dataset, never hardcoded. */
export function cityHealth(rows: { severity: string; status: string; priority_score: number }[]): number {
  const active = rows.filter((r) => r.status !== "resolved");
  if (rows.length === 0) return 100;
  const resolvedRatio = (rows.length - active.length) / rows.length;
  const load = active.reduce((sum, r) => {
    const w = { critical: 3.1, high: 2, medium: 1.1, low: 0.5 }[r.severity] ?? 1;
    return sum + w * (0.45 + r.priority_score / 200);
  }, 0);
  const penalty = Math.min(58, load * 1.35);
  return clamp(Math.round(100 - penalty + resolvedRatio * 9));
}

export const DEMO_CITY = {
  name: "Demo City",
  center: { lat: 17.4432, lng: 78.3931 },
  zoom: 14,
};
