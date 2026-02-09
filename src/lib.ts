import { GoogleGenAI } from "@google/genai";
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
  name: string;
  address?: string;
  location: LatLng;
  placeId?: string;
  vibe_score?: number;
  risk_level?: RiskLevel;
};

const PLACES_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";
const PLACES_NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby";

export async function placeTextSearch(apiKey: string, query: string): Promise<PlaceCandidate | null> {
  const res = await fetch(PLACES_TEXT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location"
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 1 })
  });

  if (!res.ok) throw new Error(`Places Text Search failed (${res.status})`);
  const data = await res.json();
  const p = data?.places?.[0];
  if (!p?.location) return null;

  return {
    name: p.displayName?.text ?? query,
    address: p.formattedAddress,
    location: { lat: p.location.latitude, lng: p.location.longitude },
    placeId: p.id
  };
}

export async function nearbyCandidates(apiKey: string, center: LatLng, radiusM: number): Promise<PlaceCandidate[]> {
  const res = await fetch(PLACES_NEARBY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location"
    },
    body: JSON.stringify({
      locationRestriction: {
        circle: { center: { latitude: center.lat, longitude: center.lng }, radius: radiusM }
      },
      includedTypes: ["cafe", "restaurant", "convenience_store", "transit_station"],
      maxResultCount: 12
    })
  });

  if (!res.ok) throw new Error(`Places Nearby failed (${res.status})`);
  const data = await res.json();
  const places = (data?.places ?? []) as any[];

  return places
    .filter((p) => p?.location)
    .map((p) => ({
      name: p.displayName?.text ?? "Unknown",
      address: p.formattedAddress,
      location: { lat: p.location.latitude, lng: p.location.longitude },
      placeId: p.id
    }));
}

export async function fetchCrimeoMeterCsi(apiKey: string, lat: number, lng: number, distanceM: number): Promise<number> {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

  const url =
    `https://api.crimeometer.com/v2/incidents/stats` +
    `?lat=${encodeURIComponent(lat)}` +
    `&lon=${encodeURIComponent(lng)}` +
    `&datetime_ini=${encodeURIComponent(start.toISOString())}` +
    `&datetime_end=${encodeURIComponent(end.toISOString())}` +
    `&distance=${encodeURIComponent(distanceM)}`;

  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", "x-api-key": apiKey }
  });

  if (!res.ok) throw new Error(`CrimeoMeter failed (${res.status})`);
  const data = await res.json();

  const csi = Number(data?.csi);
  if (Number.isFinite(csi)) return Math.max(0, Math.min(100, csi));
  throw new Error("CrimeoMeter response missing csi");
}

// ---------- Deterministic scoring (stable demo) ----------
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

// ---------- Gemini classification (schema-enforced) ----------
const outputSchema = z.object({
  risk_level: z.enum(["SAFE", "CAUTION", "UNSAFE"]),
  classification: z.enum(["SAFE", "UNSAFE", "SOCIAL_BALANCED", "INFRA_MISMATCH", "UNCERTAIN"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(240)
});

export async function geminiClassify(args: {
  csi: number;
  radiance: number;
  vibe_score: number;
  lighting_score: number;
}): Promise<{ risk_level: RiskLevel; classification: Classification; confidence: number; rationale: string }> {
  // AI Studio injects Gemini auth for the app; keep empty object here.
  const ai = new GoogleGenAI({});

  const prompt = `
You are GlowPath SafetyClassifier.

Signals:
- CSI (0-100, higher = higher risk): ${args.csi.toFixed(2)}
- Night-light radiance (proxy, noisy): ${args.radiance.toFixed(4)}
- Precomputed: vibe_score=${args.vibe_score}, lighting_score=${args.lighting_score}

Rules:
- If CSI>=70 and lighting_score>=60 -> SOCIAL_BALANCED
- If CSI<=60 and lighting_score<=35 -> INFRA_MISMATCH
- If CSI>=70 and lighting_score<=35 -> UNSAFE
- If CSI<=35 and lighting_score>=60 -> SAFE
- Else -> UNCERTAIN

Hard constraints:
- risk_level MUST match vibe_score thresholds: SAFE>=65, CAUTION 40-64, UNSAFE<40
- rationale <= 240 chars; mention CSI + lighting plainly.
Return JSON only.
`.trim();

  const resp = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: zodToJsonSchema(outputSchema)
    }
  });

  return outputSchema.parse(JSON.parse(resp.text));
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
