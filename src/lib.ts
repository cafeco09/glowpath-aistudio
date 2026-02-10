import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export type LatLng = { lat: number; lng: number };
export type RiskLevel = "SAFE" | "CAUTION" | "UNSAFE";
export type Classification = "SAFE" | "UNSAFE" | "SOCIAL_BALANCED" | "INFRA_MISMATCH" | "UNCERTAIN";

export type GlowPathResult = {
  vibe_score: number;
  risk_level: RiskLevel;
  classification: Classification;
  social_warmth: number;
  lighting_score: number;
  crime_baseline: number;
  confidence: number;
  safe_haven_nearby: boolean;
  rationale: string;
};

export type PlaceCandidate = {
  open_at_time?: boolean | null;
  hours_known?: boolean;
  name: string;
  address?: string;
  location: LatLng;
  placeId?: string;
  vibe_score?: number;
  risk_level?: RiskLevel;
};

// ✅ Live Cloud Run backend
const BACKEND_URL = "https://glowpath-backend-256981057579.europe-west2.run.app";

export async function placeTextSearch(_apiKey: string, query: string): Promise<PlaceCandidate | null> {
  const res = await fetch(`${BACKEND_URL}/place/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query })
  });

  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Backend place/text failed (${res.status})`);

  const p = await res.json();
  return {
    name: p.name ?? query,
    address: p.address,
    location: { lat: p.location.lat, lng: p.location.lng },
    placeId: p.placeId
  };
}

export async function nearbyCandidates(_apiKey: string, center: LatLng, radiusM: number, whenIso?: string): Promise<PlaceCandidate[]> {
  const res = await fetch(`${BACKEND_URL}/place/nearby_open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ center, radius_m: radiusM, max_results: 12, when_iso: whenIso ?? null })
  });

  if (!res.ok) throw new Error(`Backend place/nearby_open failed (${res.status})`);
  const data = await res.json();

  return (data ?? []).map((p: any) => ({
    name: p.name ?? "Unknown",
    address: p.address,
    location: { lat: p.location.lat, lng: p.location.lng },
    placeId: p.placeId,
    hours_known: Boolean(p.hours_known),
    open_at_time: (p.open_at_time === true ? true : (p.open_at_time === false ? false : null))
  }));
}


export async function fetchCrimeoMeterCsi(_apiKey: string, lat: number, lng: number, distanceM: number): Promise<number> {
  const url = new URL(`${BACKEND_URL}/crime/csi`);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lng", String(lng));
  url.searchParams.set("distance_m", String(distanceM));
  url.searchParams.set("days", "30");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Backend crime/csi failed (${res.status})`);

  const data = await res.json();
  const csi = Number(data?.csi);
  if (!Number.isFinite(csi)) throw new Error("Backend response missing csi");
  return csi;
}

// ---------- Deterministic scoring ----------
export function lightingScoreFromRadiance(r: number): number {
  const rad = Math.max(0, r);
  if (rad < 0.5) return 15;
  if (rad < 2.0) return 35;
  if (rad < 10.0) return 65;
  return 85;
}

export function vibeScore(crimeCsi: number, lightingScore: number): number {
  const csi = Math.max(0, Math.min(100, crimeCsi));
  const light = Math.max(0, Math.min(100, lightingScore));
  return Math.round(0.7 * (100 - csi) + 0.3 * light);
}

export function socialWarmthProxy(crimeCsi: number, lightingScore: number): number {
  const csi = Math.max(0, Math.min(100, crimeCsi));
  const light = Math.max(0, Math.min(100, lightingScore));
  return Math.round(0.7 * light + 0.3 * (100 - csi));
}

export function riskLevelFromVibe(v: number): RiskLevel {
  if (v >= 65) return "SAFE";
  if (v >= 40) return "CAUTION";
  return "UNSAFE";
}



// ---------- Classification (server-side: Gemini primary, OpenAI fallback) ----------
export async function geminiClassify(args: {
  csi: number;
  radiance: number;
  vibe_score: number;
  lighting_score: number;
}): Promise<{ risk_level: RiskLevel; classification: Classification; confidence: number; rationale: string }> {
  const res = await fetch(`${BACKEND_URL}/gemini/classify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args)
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Backend gemini/classify failed (${res.status}) ${txt.slice(0, 200)}`);
  }

  const out: any = await res.json();
  return {
    risk_level: out.risk_level,
    classification: out.classification,
    confidence: Number(out.confidence ?? 0.55),
    rationale: String(out.rationale ?? "").slice(0, 240)
  };
}

export function assembleFinalResult(params: {
  vibe_score: number;
  lighting_score: number;
  crime_baseline: number;
  social_warmth: number;
  modelOut: { risk_level: RiskLevel; classification: Classification; confidence: number; rationale: string };
}): GlowPathResult {
  return {
    vibe_score: params.vibe_score,
    risk_level: params.modelOut.risk_level,
    classification: params.modelOut.classification,
    social_warmth: params.social_warmth,
    lighting_score: params.lighting_score,
    crime_baseline: params.crime_baseline,
    confidence: params.modelOut.confidence,
    safe_haven_nearby: false,
    rationale: params.modelOut.rationale
  };
}
