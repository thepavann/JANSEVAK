import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  cityHealth,
  computeCivicImpact,
  distanceMeters,
  explainPriority,
  ISSUE_LABELS,
  severityRank,
  textSimilarity,
  type ScoreBreakdown,
  type Severity,
} from "./civic";

function db(): SupabaseClient<Database> {
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
  return createClient<Database>(process.env["SUPABASE_URL"]!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const h = new Headers(init?.headers);
        if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`)
          h.delete("Authorization");
        h.set("apikey", key);
        // One retry: a transient network failure here would otherwise blank the page.
        try {
          return await fetch(input, { ...init, headers: h });
        } catch {
          await new Promise((r) => setTimeout(r, 250));
          return await fetch(input, { ...init, headers: h });
        }
      },
    },
  });
}


export type ReportRow = Database["public"]["Tables"]["reports"]["Row"];
export type ClusterRow = Database["public"]["Tables"]["clusters"]["Row"];
export type AnalysisRow = Database["public"]["Tables"]["ai_analysis"]["Row"];
export type ObservationRow = Database["public"]["Tables"]["observations"]["Row"];

/* ------------------------------------------------------------------ reads */

export const listReports = createServerFn({ method: "GET" }).handler(async () => {
  const { data, error } = await db()
    .from("reports")
    .select("*")
    .order("priority_score", { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  return data ?? [];
});

export const listClusters = createServerFn({ method: "GET" }).handler(async () => {
  const { data, error } = await db()
    .from("clusters")
    .select("*")
    .order("priority_score", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
});

export const getReport = createServerFn({ method: "GET" })
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    const client = db();
    const [{ data: report, error }, { data: analysis }] = await Promise.all([
      client.from("reports").select("*").eq("id", data.id).maybeSingle(),
      client
        .from("ai_analysis")
        .select("*")
        .eq("report_id", data.id)
        .order("created_at", { ascending: false })
        .limit(1),
    ]);
    if (error) throw new Error(error.message);
    if (!report) return null;

    const { data: cluster } = report.cluster_id
      ? await client.from("clusters").select("*").eq("id", report.cluster_id).maybeSingle()
      : { data: null };

    const { data: siblings } = report.cluster_id
      ? await client
          .from("reports")
          .select("*")
          .eq("cluster_id", report.cluster_id)
          .neq("id", report.id)
      : { data: [] };

    return {
      report,
      analysis: analysis?.[0] ?? null,
      cluster: cluster ?? null,
      siblings: siblings ?? [],
    };
  });

export const getCluster = createServerFn({ method: "GET" })
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    const client = db();
    const { data: cluster, error } = await client
      .from("clusters")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!cluster) return null;
    const { data: reports } = await client
      .from("reports")
      .select("*")
      .eq("cluster_id", data.id)
      .order("priority_score", { ascending: false });
    const { data: actions } = await client.from("actions").select("*").eq("cluster_id", data.id);
    return { cluster, reports: reports ?? [], actions: actions ?? [] };
  });

export const getDashboard = createServerFn({ method: "GET" }).handler(async () => {
  const client = db();
  const [{ data: reports, error }, { data: clusters }, { data: observations }] = await Promise.all([
    client.from("reports").select("*"),
    client.from("clusters").select("*").order("priority_score", { ascending: false }),
    client.from("observations").select("*").eq("status", "flagged"),
  ]);
  if (error) throw new Error(error.message);
  const all = reports ?? [];
  const active = all.filter((r) => r.status !== "resolved");
  const count = (s: string) => active.filter((r) => r.severity === s).length;

  const queue = [
    ...(clusters ?? []).map((c) => ({
      kind: "cluster" as const,
      id: c.id,
      title: c.title,
      priority: c.priority_score,
      related: c.report_count,
      status: c.status,
      issue_type: c.issue_type,
      location: null as string | null,
    })),
    ...active
      .filter((r) => !r.cluster_id)
      .map((r) => ({
        kind: "report" as const,
        id: r.id,
        title: `${ISSUE_LABELS[r.issue_type] ?? r.issue_type}${r.address_label ? ` — ${r.address_label}` : ""}`,
        priority: r.priority_score,
        related: r.related_count,
        status: r.status,
        issue_type: r.issue_type,
        location: r.address_label,
      })),
  ]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 12);

  const topCluster = (clusters ?? [])[0] ?? null;

  return {
    cityHealth: cityHealth(all),
    activeIssues: active.length,
    totals: {
      critical: count("critical"),
      high: count("high"),
      medium: count("medium"),
      low: count("low"),
      resolved: all.length - active.length,
      clusters: (clusters ?? []).length,
      flaggedUnreported: (observations ?? []).length,
      reports: all.length,
    },
    queue,
    clusters: clusters ?? [],
    insight: topCluster
      ? {
          title: topCluster.title,
          text:
            topCluster.ai_summary ??
            `${topCluster.report_count} citizen reports may describe one underlying civic problem.`,
          clusterId: topCluster.id,
          reportCount: topCluster.report_count,
          confidence: Number(topCluster.confidence),
          impact: topCluster.priority_score,
        }
      : null,
  };
});

export const getNearbyReports = createServerFn({ method: "GET" })
  .inputValidator((d: { lat: number; lng: number; radius?: number }) => d)
  .handler(async ({ data }) => {
    const radius = data.radius ?? 300;
    const { data: rows, error } = await db().from("reports").select("*").limit(500);
    if (error) throw new Error(error.message);
    return (rows ?? [])
      .map((r) => ({
        ...r,
        distance_m: distanceMeters(
          { lat: data.lat, lng: data.lng },
          { lat: r.latitude, lng: r.longitude },
        ),
      }))
      .filter((r) => r.distance_m <= radius)
      .sort((a, b) => a.distance_m - b.distance_m)
      .slice(0, 12);
  });

export const listObservations = createServerFn({ method: "GET" }).handler(async () => {
  const { data, error } = await db()
    .from("observations")
    .select("*")
    .order("priority_score", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
});

/* -------------------------------------------------------------- analysis */

export type AnalyzeResult = {
  ai: {
    issue_type: string;
    severity: Severity;
    confidence: number;
    evidence: string[];
    observations: string[];
    provided_facts: string[];
    inferences: string[];
    reasoning: string;
    recommended_action: string;
    root_cause_hypothesis: string | null;
    cluster_confidence: number | null;
    traffic_exposure: string;
    pedestrian_exposure: string;
    sensitive_location: string;
    sensitive_location_note: string | null;
    model: string;
  };
  score: number;
  breakdown: ScoreBreakdown;
  priority_reason: string;
  duplicates: {
    id: string;
    description: string;
    issue_type: string;
    distance_m: number;
    similarity: number;
    cluster_id: string | null;
  }[];
  source: "featherless";
};

export const analyzeReport = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      description: string;
      imageDataUrl?: string | null;
      latitude: number;
      longitude: number;
      language?: string;
    }) => {
      if (!d.description || d.description.trim().length < 8)
        throw new Error("Please describe the problem in at least a few words.");
      if (d.description.length > 1200) throw new Error("Description is too long.");
      if (
        typeof d.latitude !== "number" ||
        typeof d.longitude !== "number" ||
        Math.abs(d.latitude) > 90 ||
        Math.abs(d.longitude) > 180
      )
        throw new Error("A valid location is required.");
      if (d.imageDataUrl) {
        if (!/^data:image\/(jpeg|jpg|png|webp);base64,/.test(d.imageDataUrl))
          throw new Error("Unsupported image format.");
        if (d.imageDataUrl.length > 4_500_000) throw new Error("Image is too large.");
      }
      return d;
    },
  )
  .handler(async ({ data }): Promise<AnalyzeResult> => {
    const client = db();
    const { data: rows } = await client.from("reports").select("*").limit(500);

    const nearbyAll = (rows ?? [])
      .map((r) => ({
        ...r,
        distance_m: distanceMeters(
          { lat: data.latitude, lng: data.longitude },
          { lat: r.latitude, lng: r.longitude },
        ),
      }))
      .filter((r) => r.distance_m <= 300)
      .sort((a, b) => a.distance_m - b.distance_m)
      .slice(0, 8);

    const { analyzeCivicEvidence } = await import("./featherless.server");
    const ai = await analyzeCivicEvidence({
      description: data.description,
      imageDataUrl: data.imageDataUrl ?? null,
      latitude: data.latitude,
      longitude: data.longitude,
      language: data.language ?? "en",
      nearby: nearbyAll.map((r) => ({
        id: r.id,
        issue_type: r.issue_type,
        description: r.description,
        distance_m: r.distance_m,
        severity: r.severity,
      })),
    });

    // Duplicate detection: geography + issue type + AI semantic match + lexical similarity.
    const duplicates = nearbyAll
      .map((r) => {
        const similarity = textSimilarity(data.description, r.description);
        const aiMatch = ai.related_report_ids.includes(r.id);
        const typeMatch = r.issue_type === ai.issue_type;
        const score =
          (aiMatch ? 0.6 : 0) +
          (typeMatch ? 0.2 : 0) +
          similarity * 0.3 +
          (r.distance_m < 120 ? 0.15 : 0);
        return { r, similarity, score, typeMatch };
      })
      .filter((x) => x.typeMatch && x.score >= 0.45 && x.r.distance_m <= 250)
      .map((x) => ({
        id: x.r.id,
        description: x.r.description,
        issue_type: x.r.issue_type,
        distance_m: x.r.distance_m,
        similarity: Number(x.similarity.toFixed(2)),
        cluster_id: x.r.cluster_id,
      }));

    const { score, breakdown } = computeCivicImpact({
      severity: ai.severity,
      traffic_exposure: ai.traffic_exposure,
      pedestrian_exposure: ai.pedestrian_exposure,
      sensitive_location: ai.sensitive_location,
      related_reports: duplicates.length,
    });

    return {
      ai: {
        issue_type: ai.issue_type,
        severity: ai.severity,
        confidence: ai.confidence,
        evidence: ai.evidence,
        observations: ai.observations,
        provided_facts: ai.provided_facts,
        inferences: ai.inferences,
        reasoning: ai.reasoning,
        recommended_action: ai.recommended_action,
        root_cause_hypothesis: ai.root_cause_hypothesis,
        cluster_confidence: ai.cluster_confidence,
        traffic_exposure: ai.traffic_exposure,
        pedestrian_exposure: ai.pedestrian_exposure,
        sensitive_location: ai.sensitive_location,
        sensitive_location_note: ai.sensitive_location_note,
        model: ai.model,
      },
      score,
      breakdown,
      priority_reason: explainPriority(breakdown, {
        severity: ai.severity,
        related: duplicates.length,
        sensitive: ai.sensitive_location !== "none",
      }),
      duplicates,
      source: "featherless",
    };
  });

/* ------------------------------------------------------------- mutations */

async function recalcCluster(client: SupabaseClient<Database>, clusterId: string) {
  const { data: members } = await client
    .from("reports")
    .select("*")
    .eq("cluster_id", clusterId);
  const rows = members ?? [];
  if (rows.length === 0) return;
  const top = rows.reduce((a, b) => (b.priority_score > a.priority_score ? b : a));
  const priority = Math.min(100, top.priority_score + Math.min(6, rows.length));
  await client
    .from("clusters")
    .update({
      report_count: rows.length,
      priority_score: priority,
      center_lat: rows.reduce((s, r) => s + r.latitude, 0) / rows.length,
      center_lng: rows.reduce((s, r) => s + r.longitude, 0) / rows.length,
    })
    .eq("id", clusterId);
  await client
    .from("reports")
    .update({ related_count: rows.length - 1 })
    .eq("cluster_id", clusterId);
}

export const createReport = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      analysis: AnalyzeResult;
      description: string;
      imageDataUrl?: string | null;
      latitude: number;
      longitude: number;
      language?: string;
      addressLabel?: string | null;
      reporterName?: string | null;
      mergeWith?: string | null;
    }) => d,
  )
  .handler(async ({ data }) => {
    const client = db();
    const a = data.analysis;

    let clusterId: string | null = null;

    if (data.mergeWith) {
      const { data: target } = await client
        .from("reports")
        .select("*")
        .eq("id", data.mergeWith)
        .maybeSingle();
      if (target) {
        if (target.cluster_id) {
          clusterId = target.cluster_id;
        } else {
          const { reasonAboutCluster } = await import("./featherless.server");
          let rootCause = a.ai.root_cause_hypothesis;
          let confidence = a.ai.cluster_confidence ?? 0.8;
          let summary = a.ai.reasoning;
          try {
            const reasoned = await reasonAboutCluster([
              {
                id: "new",
                issue_type: a.ai.issue_type,
                description: data.description,
                distance_m: 0,
              },
              {
                id: target.id,
                issue_type: target.issue_type,
                description: target.description,
                distance_m: distanceMeters(
                  { lat: data.latitude, lng: data.longitude },
                  { lat: target.latitude, lng: target.longitude },
                ),
              },
            ]);
            if (reasoned) {
              rootCause = reasoned.root_cause;
              confidence = reasoned.confidence;
              summary = reasoned.summary || summary;
            }
          } catch {
            /* cluster reasoning is best-effort; membership is deterministic */
          }
          const { data: created } = await client
            .from("clusters")
            .insert({
              title: `${ISSUE_LABELS[a.ai.issue_type] ?? a.ai.issue_type}${
                data.addressLabel ? ` — ${data.addressLabel}` : ""
              }`,
              issue_type: a.ai.issue_type,
              center_lat: data.latitude,
              center_lng: data.longitude,
              root_cause: rootCause,
              confidence,
              priority_score: a.score,
              ai_summary: summary,
              report_count: 1,
            })
            .select()
            .single();
          clusterId = created?.id ?? null;
          if (clusterId) await client.from("reports").update({ cluster_id: clusterId }).eq("id", target.id);
        }
      }
    }

    const related = clusterId ? a.duplicates.length : a.duplicates.length;

    const { data: report, error } = await client
      .from("reports")
      .insert({
        reporter_name: data.reporterName ?? "Citizen",
        language: data.language ?? "en",
        image_url: data.imageDataUrl ?? null,
        description: data.description,
        address_label: data.addressLabel ?? null,
        latitude: data.latitude,
        longitude: data.longitude,
        issue_type: a.ai.issue_type,
        severity: a.ai.severity,
        priority_score: a.score,
        score_breakdown: a.breakdown,
        priority_reason: a.priority_reason,
        related_count: related,
        school_nearby: /school|college|hospital/i.test(
          `${a.ai.sensitive_location_note ?? ""} ${data.description}`,
        ),
        status: "open",
        is_demo: false,
        ai_source: "featherless",
        cluster_id: clusterId,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    await client.from("ai_analysis").insert({
      report_id: report.id,
      detected_issue: a.ai.issue_type,
      severity: a.ai.severity,
      confidence: a.ai.confidence,
      evidence: a.ai.evidence,
      observations: a.ai.observations,
      provided_facts: a.ai.provided_facts,
      inferences: a.ai.inferences,
      reasoning: a.ai.reasoning,
      recommended_action: a.ai.recommended_action,
      model: a.ai.model,
      source: "featherless",
    });

    await client.from("actions").insert({
      report_id: report.id,
      cluster_id: clusterId,
      recommended_action: a.ai.recommended_action,
      priority: a.score,
      status: "pending",
    });

    if (clusterId) await recalcCluster(client, clusterId);

    return { id: report.id, clusterId };
  });

export const updateReportStatus = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; status: string; assignedTo?: string | null }) => {
    const ok = ["open", "in_review", "in_progress", "resolved"];
    if (!ok.includes(d.status)) throw new Error("Invalid status");
    return d;
  })
  .handler(async ({ data }) => {
    const client = db();
    const { error } = await client
      .from("reports")
      .update({
        status: data.status,
        resolved_at: data.status === "resolved" ? new Date().toISOString() : null,
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    if (data.assignedTo) {
      await client
        .from("actions")
        .update({
          assigned_to: data.assignedTo,
          status: data.status,
          updated_at: new Date().toISOString(),
        })
        .eq("report_id", data.id);
    }
    return { ok: true };
  });

export const updateClusterStatus = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; status: string }) => d)
  .handler(async ({ data }) => {
    const client = db();
    await client.from("clusters").update({ status: data.status }).eq("id", data.id);
    await client
      .from("reports")
      .update({
        status: data.status,
        resolved_at: data.status === "resolved" ? new Date().toISOString() : null,
      })
      .eq("cluster_id", data.id);
    await client
      .from("actions")
      .update({ status: data.status, updated_at: new Date().toISOString() })
      .eq("cluster_id", data.id);
    return { ok: true };
  });

/** Groups an existing report into a cluster (authority-side merge). */
export const mergeIntoCluster = createServerFn({ method: "POST" })
  .inputValidator((d: { reportId: string; clusterId: string }) => d)
  .handler(async ({ data }) => {
    const client = db();
    await client
      .from("reports")
      .update({ cluster_id: data.clusterId })
      .eq("id", data.reportId);
    await recalcCluster(client, data.clusterId);
    return { ok: true };
  });

/** Real AI reasoning over prepared historical observations (Discover). */
export const analyzeUnreported = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    const client = db();
    const { data: obs } = await client
      .from("observations")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (!obs) throw new Error("Observation not found");

    const { data: rows } = await client.from("reports").select("*").limit(500);
    const existing = (rows ?? []).filter(
      (r) =>
        r.issue_type === obs.issue_type &&
        distanceMeters(
          { lat: obs.latitude, lng: obs.longitude },
          { lat: r.latitude, lng: r.longitude },
        ) <= 150,
    );

    const { analyzeCivicEvidence } = await import("./featherless.server");
    const ai = await analyzeCivicEvidence({
      description:
        `Historical observation comparison at ${obs.address_label ?? "a city location"}. ` +
        `Earlier observation state: "${obs.previous_state}". Recent observation state: "${obs.recent_state}". ` +
        `Issue type under review: ${obs.issue_type}. ` +
        `${existing.length === 0 ? "No citizen report exists for this location." : `${existing.length} citizen report(s) already exist nearby.`}`,
      imageDataUrl: null,
      latitude: obs.latitude,
      longitude: obs.longitude,
    });

    const { score, breakdown } = computeCivicImpact({
      severity: ai.severity,
      traffic_exposure: ai.traffic_exposure,
      pedestrian_exposure: ai.pedestrian_exposure,
      sensitive_location: ai.sensitive_location,
      related_reports: existing.length,
    });

    await client
      .from("observations")
      .update({
        priority_score: score,
        score_breakdown: breakdown,
        ai_reasoning: ai.reasoning,
        evidence: ai.evidence,
      })
      .eq("id", obs.id);

    return {
      score,
      breakdown,
      reasoning: ai.reasoning,
      evidence: ai.evidence,
      inferences: ai.inferences,
      recommended_action: ai.recommended_action,
      confidence: ai.confidence,
      existingReports: existing.length,
      model: ai.model,
    };
  });

/** Deterministic decision-support scenarios (clearly labelled estimates). */
export function whatIfScenarios(current: number, severity: string) {
  const drift = { critical: 1.28, high: 1.2, medium: 1.12, low: 1.06 }[severity] ?? 1.15;
  return [
    { key: "none", label: "No action (90 days)", value: Math.min(100, Math.round(current * drift)) },
    { key: "basic", label: "Basic intervention", value: Math.max(5, Math.round(current * 0.55)) },
    { key: "full", label: "Full repair", value: Math.max(3, Math.round(current * 0.24)) },
  ];
}

export function rankLabel(i: number) {
  return String(i + 1).padStart(2, "0");
}

export { severityRank };
