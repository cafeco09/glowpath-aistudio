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

export default function App() {
  const [mapsKey, setMapsKey] = useState("");
  const [crimeoKey, setCrimeoKey] = useState("");

  const [destination, setDestination] = useState("Soho, London");
  const [radianceOverride, setRadianceOverride] = useState("6.3");

  const [status, setStatus] = useState("");
  const [err, setErr] = useState("");
  const [result, setResult] = useState<GlowPathResult | null>(null);
  const [alts, setAlts] = useState<PlaceCandidate[]>([]);

  const canRun = useMemo(
    () => mapsKey.trim().length > 10 && crimeoKey.trim().length > 10,
    [mapsKey, crimeoKey]
  );

  async function assess() {
    setErr("");
    setStatus("Finding place…");
    setResult(null);
    setAlts([]);

    try {
      if (!canRun) throw new Error("Paste your Google Maps key and CrimeoMeter key first.");

      const dest = await placeTextSearch(mapsKey, destination);
      if (!dest) throw new Error("No place found for that name.");

      setStatus("Fetching CrimeoMeter CSI…");
      const csi = await fetchCrimeoMeterCsi(crimeoKey, dest.location.lat, dest.location.lng, RADIUS_M);

      const radiance = Number(radianceOverride);
      if (!Number.isFinite(radiance)) throw new Error("Radiance override must be a number.");

      const lighting = lightingScoreFromRadiance(radiance);
      const vibe = vibeScore(csi, lighting);
      const warmth = socialWarmthProxy(csi, lighting);

      setStatus("Asking Gemini for mismatch classification…");
      const modelOut = await geminiClassify({
        csi,
        radiance,
        vibe_score: vibe,
        lighting_score: lighting
      });

      // Enforce deterministic risk level (don’t let the model drift)
      const expected = riskLevelFromVibe(vibe);
      const fixedModelOut = { ...modelOut, risk_level: expected };

      setResult(
        assembleFinalResult({
          vibe_score: vibe,
          lighting_score: lighting,
          crime_baseline: Math.round(csi),
          social_warmth: warmth,
          modelOut: fixedModelOut
        })
      );

      setStatus("Done.");
    } catch (e: any) {
      setStatus("");
      setErr(e?.message ?? "Unknown error");
    }
  }

  async function findAlternatives() {
    setErr("");
    setStatus("Finding nearby alternatives…");
    setAlts([]);

    try {
      if (!canRun) throw new Error("Paste your Google Maps key and CrimeoMeter key first.");

      const dest = await placeTextSearch(mapsKey, destination);
      if (!dest) throw new Error("No place found for that name.");

      const candidates = await nearbyCandidates(mapsKey, dest.location, RADIUS_M);

      const radiance = Number(radianceOverride);
      if (!Number.isFinite(radiance)) throw new Error("Radiance override must be a number.");
      const lighting = lightingScoreFromRadiance(radiance);

      // Keep calls low for demo speed
      const shortlist = candidates.slice(0, 8);

      const scored: PlaceCandidate[] = [];
      for (const c of shortlist) {
        const csi = await fetchCrimeoMeterCsi(crimeoKey, c.location.lat, c.location.lng, RADIUS_M);
        const vibe = vibeScore(csi, lighting);
        scored.push({ ...c, vibe_score: vibe, risk_level: riskLevelFromVibe(vibe) });
      }

      scored.sort((a, b) => (b.vibe_score ?? 0) - (a.vibe_score ?? 0));
      setAlts(scored.slice(0, 5));
      setStatus("Done.");
    } catch (e: any) {
      setStatus("");
      setErr(e?.message ?? "Unknown error");
    }
  }

  return (
    <div className="container">
      <header>
        <h1>GlowPath</h1>
        <p className="sub">Type a place → get a safety vibe + safer nearby alternatives (prototype)</p>
      </header>

      <section className="card">
        <h2>Keys (paste at runtime)</h2>
        <div className="grid2">
          <label>
            Google Maps API Key
            <input value={mapsKey} onChange={(e) => setMapsKey(e.target.value)} placeholder="AIza…" />
          </label>
          <label>
            CrimeoMeter API Key
            <input value={crimeoKey} onChange={(e) => setCrimeoKey(e.target.value)} placeholder="x-api-key…" />
          </label>
        </div>
        <p className="hint">
          Gemini auth is handled by AI Studio. Don’t paste Gemini keys into the UI.
        </p>
      </section>

      <section className="card">
        <h2>Assess a destination</h2>
        <div className="grid2">
          <label>
            Destination place name
            <input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="e.g., Oxford Circus" />
          </label>
          <label>
            Night-light radiance override (demo)
            <input value={radianceOverride} onChange={(e) => setRadianceOverride(e.target.value)} placeholder="e.g., 6.3" />
          </label>
        </div>

        <div className="buttons">
          <button onClick={assess} disabled={!canRun}>Assess safety</button>
          <button onClick={findAlternatives} disabled={!canRun}>Find safer nearby alternatives</button>
        </div>

        {status && <p className="status">{status}</p>}
        {err && <p className="error">{err}</p>}

        {result && (
          <div className="result">
            <h3>Safety JSON</h3>
            <pre>{JSON.stringify(result, null, 2)}</pre>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Top nearby alternatives</h2>
        {alts.length === 0 ? (
          <p className="hint">Click “Find safer nearby alternatives”.</p>
        ) : (
          <ul className="list">
            {alts.map((a, idx) => (
              <li key={idx}>
                <div className="row">
                  <div>
                    <strong>{a.name}</strong>
                    {a.address ? <div className="muted">{a.address}</div> : null}
                  </div>
                  <div className="badge">
                    {a.risk_level} • {a.vibe_score}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="footer">
        <div className="muted">
          Prototype note: radiance is a proxy; CSI is an index. This demonstrates mismatch reasoning, not ground-truth safety.
        </div>
      </footer>
    </div>
  );
}
