import React, { useMemo, useState } from "react";
import "./styles.css";

import {
  assembleFinalResult,
  fetchCrimeoMeterCsi,
  geminiClassify,
  lightingScoreFromRadiance,
  nearbyCandidates,
  placeTextSearch,
  riskLevelFromVibe,
  socialWarmthProxy,
  vibeScore,
  type GlowPathResult,
  type PlaceCandidate
} from "./lib";

const RADIUS_M = 700;

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function pillClass(level: string) {
  if (level === "SAFE") return "pill pill-safe";
  if (level === "CAUTION") return "pill pill-caution";
  return "pill pill-unsafe";
}
function labelForScore(v: number) {
  if (v >= 65) return "Good";
  if (v >= 40) return "Mixed";
  return "Poor";
}
function openBadge(p: PlaceCandidate) {
  if (p.open_at_time === true) return { text: "OPEN", cls: "pill pill-safe" };
  if (p.open_at_time === false) return { text: "CLOSED", cls: "pill pill-unsafe" };
  return { text: "HOURS UNKNOWN", cls: "pill pill-caution" };
}
function toDatetimeLocalValue(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function App() {
  const [destination, setDestination] = useState("Soho, London");
  const [radianceOverride, setRadianceOverride] = useState("6.3");
  const [whenLocal, setWhenLocal] = useState(toDatetimeLocalValue(new Date()));

  const [status, setStatus] = useState("");
  const [err, setErr] = useState("");
  const [result, setResult] = useState<GlowPathResult | null>(null);
  const [alts, setAlts] = useState<PlaceCandidate[]>([]);
  const [showJson, setShowJson] = useState(false);

  function whenIso(): string { return new Date(whenLocal).toISOString(); }

  async function assess() {
    setErr(""); setStatus("Finding place…"); setResult(null); setAlts([]);
    try {
      const dest = await placeTextSearch("", destination);
      if (!dest) throw new Error("No place found for that name.");

      setStatus("Fetching crime baseline…");
      const csi = await fetchCrimeoMeterCsi("", dest.location.lat, dest.location.lng, RADIUS_M);

      const radiance = Number(radianceOverride);
      if (!Number.isFinite(radiance)) throw new Error("Night-light intensity must be a number.");

      const lighting = lightingScoreFromRadiance(radiance);
      const vibe = vibeScore(csi, lighting);
      const warmth = socialWarmthProxy(csi, lighting);

      setStatus("Classifying safety vibe…");
      const modelOut = await geminiClassify({ csi, radiance, vibe_score: vibe, lighting_score: lighting });

      const expected = riskLevelFromVibe(vibe);
      const fixedModelOut = { ...modelOut, risk_level: expected };

      setResult(assembleFinalResult({
        vibe_score: vibe,
        lighting_score: lighting,
        crime_baseline: Math.round(csi),
        social_warmth: warmth,
        modelOut: fixedModelOut
      }));

      setStatus("Done.");
    } catch (e: any) {
      setStatus(""); setErr(e?.message ?? "Unknown error");
    }
  }

  async function findAlternatives() {
    setErr(""); setStatus("Finding nearby alternatives…"); setAlts([]);
    try {
      const dest = await placeTextSearch("", destination);
      if (!dest) throw new Error("No place found for that name.");

      const candidates = await nearbyCandidates("", dest.location, RADIUS_M, whenIso());

      const radiance = Number(radianceOverride);
      if (!Number.isFinite(radiance)) throw new Error("Night-light intensity must be a number.");
      const lighting = lightingScoreFromRadiance(radiance);

      const shortlist = candidates.slice(0, 10);
      const scored: PlaceCandidate[] = [];
      for (const c of shortlist) {
        const csi = await fetchCrimeoMeterCsi("", c.location.lat, c.location.lng, RADIUS_M);
        const vibe = vibeScore(csi, lighting);
        scored.push({ ...c, vibe_score: vibe, risk_level: riskLevelFromVibe(vibe) });
      }

      const kept = scored.filter(p => p.open_at_time !== false);
      kept.sort((a, b) => {
        const ao = a.open_at_time === true ? 1 : 0;
        const bo = b.open_at_time === true ? 1 : 0;
        if (bo !== ao) return bo - ao;
        return (b.vibe_score ?? 0) - (a.vibe_score ?? 0);
      });

      setAlts(kept.slice(0, 5));
      setStatus("Done.");
    } catch (e: any) {
      setStatus(""); setErr(e?.message ?? "Unknown error");
    }
  }

  const summary = useMemo(() => {
    if (!result) return null;
    return {
      vibe: result.vibe_score,
      vibeLabel: labelForScore(result.vibe_score),
      risk: result.risk_level,
      classification: result.classification,
      confPct: Math.round(clamp01(result.confidence) * 100)
    };
  }, [result]);

  return (
    <div className="container">
      <header>
        <h1>GlowPath</h1>
        <p className="sub">Time-aware safety vibe + open-at-time alternatives (prototype)</p>
      </header>

      <section className="card">
        <h2>Assess a destination</h2>

        <div className="grid2">
          <label>
            Destination
            <input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="e.g., Oxford Circus" />
          </label>

          <label>
            When are you going?
            <input type="datetime-local" value={whenLocal} onChange={(e) => setWhenLocal(e.target.value)} />
            <div className="hint">Alternatives prioritise places that are open at this time.</div>
          </label>
        </div>

        <div className="grid2">
          <label>
            Night-light intensity (demo override)
            <input value={radianceOverride} onChange={(e) => setRadianceOverride(e.target.value)} />
            <div className="hint">Proxy for satellite night lighting (higher ≈ brighter).</div>
          </label>
          <div />
        </div>

        <div className="buttons">
          <button onClick={assess}>Assess safety</button>
          <button onClick={findAlternatives}>Find open safer alternatives</button>
        </div>

        {status && <p className="status">{status}</p>}
        {err && <p className="error">{err}</p>}

        {result && summary && (
          <div className="resultCard">
            <div className="resultTop">
              <div>
                <div className="muted">Overall</div>
                <div className={pillClass(summary.risk)}>{summary.risk}</div>
              </div>

              <div>
                <div className="muted">Vibe score (0–100)</div>
                <div className="big">{summary.vibe} <span className="muted">/ 100</span></div>
                <div className="muted">{summary.vibeLabel}</div>
              </div>

              <div>
                <div className="muted">Confidence</div>
                <div className="big">{summary.confPct}<span className="muted">%</span></div>
              </div>
            </div>

            <div className="divider" />

            <div className="grid3">
              <div className="kv">
                <div className="k">Lighting score</div>
                <div className="v">{result.lighting_score} <span className="muted">/ 100</span></div>
              </div>
              <div className="kv">
                <div className="k">Crime baseline (0–100)</div>
                <div className="v">{result.crime_baseline} <span className="muted">/ 100</span></div>
              </div>
              <div className="kv">
                <div className="k">Social warmth</div>
                <div className="v">{result.social_warmth} <span className="muted">/ 100</span></div>
              </div>
            </div>

            <div className="divider" />

            <div className="kv">
              <div className="k">Why this result?</div>
              <div className="v">{result.rationale}</div>
              <div className="muted">Classification: <strong>{result.classification}</strong></div>
            </div>

            <div className="divider" />

            <label className="toggleRow">
              <input type="checkbox" checked={showJson} onChange={(e) => setShowJson(e.target.checked)} />
              Show developer JSON (advanced)
            </label>

            {showJson && <pre className="json">{JSON.stringify(result, null, 2)}</pre>}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Top nearby alternatives (time-aware)</h2>
        {alts.length === 0 ? (
          <p className="hint">Click “Find open safer alternatives”.</p>
        ) : (
          <ul className="list">
            {alts.map((a, idx) => {
              const b = openBadge(a);
              return (
                <li key={idx}>
                  <div className="row">
                    <div>
                      <strong>{a.name}</strong>
                      {a.address ? <div className="muted">{a.address}</div> : null}
                    </div>
                    <div className="altRight">
                      <span className={b.cls}>{b.text}</span>
                      <span className="badge">{a.risk_level} • {a.vibe_score} / 100</span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <footer className="footer">
        <div className="muted">Opening hours can be missing/wrong; “Hours unknown” is shown explicitly.</div>
      </footer>
    </div>
  );
}
