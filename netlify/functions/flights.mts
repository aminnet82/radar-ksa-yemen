import type { Config } from "@netlify/functions"

// Server-side proxy: fetches live ADS-B traffic over Saudi Arabia + Yemen
// from open sources and returns one normalized list (no CORS issues in the browser).

const BBOX = { s: 11, n: 33.5, w: 33, e: 61 }
// 250 NM circles covering both countries
const POINTS: [number, number][] = [
  [29.5, 37.5], [29.5, 43.5], [29, 49], [24.5, 38.5], [24.5, 44.5], [24.5, 50.5], [23, 55.5],
  [19.5, 41.5], [19.5, 47], [19.5, 52.5], [14.5, 44.5], [14.5, 49.5],
]

type Plane = {
  hex: string; cs: string; reg: string; type: string; desc: string; origin?: string
  lat: number; lon: number; alt: number | null; gnd: boolean
  spd: number | null; trk: number | null; vs: number | null; sq: string
}

const UA = { "User-Agent": "flight-radar-ksa-yemen/1.0 (netlify function)", Accept: "application/json" }

async function getJSON(url: string, ms = 9000): Promise<any> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: UA })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.json()
  } finally {
    clearTimeout(t)
  }
}

function fromReadsb(a: any): Plane | null {
  if (a.lat == null || a.lon == null) return null
  const gnd = a.alt_baro === "ground"
  return {
    hex: a.hex, cs: (a.flight || "").trim(), reg: a.r || "", type: a.t || "", desc: a.desc || "",
    lat: a.lat, lon: a.lon,
    alt: gnd ? 0 : typeof a.alt_baro === "number" ? a.alt_baro : a.alt_geom ?? null, gnd,
    spd: a.gs ?? null, trk: a.track ?? a.true_heading ?? null, vs: a.baro_rate ?? a.geom_rate ?? null,
    sq: a.squawk || "",
  }
}

async function viaReadsbParallel(base: string): Promise<Plane[]> {
  const res = await Promise.allSettled(POINTS.map(([la, lo]) => getJSON(`${base}/v2/point/${la}/${lo}/250`)))
  const ok = res.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[]
  if (!ok.length) throw new Error((res[0] as PromiseRejectedResult).reason?.message || "no response")
  const out: Plane[] = []
  for (const r of ok) for (const a of r.value.ac || r.value.aircraft || []) { const p = fromReadsb(a); if (p) out.push(p) }
  return out
}

async function viaReadsbSequential(url: (la: number, lo: number) => string, gapMs: number): Promise<Plane[]> {
  const out: Plane[] = []
  let ok = 0, lastErr = ""
  for (const [la, lo] of POINTS) {
    try {
      const j = await getJSON(url(la, lo), 6000)
      ok++
      for (const a of j.ac || j.aircraft || []) { const p = fromReadsb(a); if (p) out.push(p) }
    } catch (e: any) { lastErr = e.message }
    await new Promise((r) => setTimeout(r, gapMs))
  }
  if (!ok) throw new Error(lastErr || "no response")
  return out
}

async function viaOpenSky(): Promise<Plane[]> {
  const j = await getJSON(
    `https://opensky-network.org/api/states/all?lamin=${BBOX.s}&lomin=${BBOX.w}&lamax=${BBOX.n}&lomax=${BBOX.e}`,
    15000,
  )
  return (j.states || []).filter((s: any[]) => s[5] != null && s[6] != null).map((s: any[]) => ({
    hex: s[0], cs: (s[1] || "").trim(), reg: "", type: "", desc: "", origin: s[2],
    lat: s[6], lon: s[5], alt: s[8] ? 0 : s[7] != null ? s[7] * 3.28084 : null, gnd: !!s[8],
    spd: s[9] != null ? s[9] * 1.94384 : null, trk: s[10], vs: s[11] != null ? s[11] * 196.85 : null, sq: s[14] || "",
  }))
}

const SOURCES: { name: string; run: () => Promise<Plane[]> }[] = [
  { name: "adsb.lol", run: () => viaReadsbParallel("https://api.adsb.lol") },
  { name: "adsb.fi", run: () => viaReadsbSequential((la, lo) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/250`, 1050) },
  { name: "airplanes.live", run: () => viaReadsbSequential((la, lo) => `https://api.airplanes.live/v2/point/${la}/${lo}/250`, 1050) },
  { name: "OpenSky Network", run: viaOpenSky },
]

export default async (req: Request) => {
  const errors: Record<string, string> = {}
  for (const s of SOURCES) {
    try {
      const raw = await s.run()
      const seen = new Map<string, Plane>()
      for (const p of raw) {
        if (p.lat < BBOX.s || p.lat > BBOX.n || p.lon < BBOX.w || p.lon > BBOX.e) continue
        seen.set(p.hex, p)
      }
      return Response.json(
        { source: s.name, time: Date.now(), count: seen.size, planes: [...seen.values()], errors },
        {
          headers: {
            "Cache-Control": "public, max-age=0, must-revalidate",
            "Netlify-CDN-Cache-Control": "public, durable, s-maxage=10, stale-while-revalidate=20",
          },
        },
      )
    } catch (e: any) {
      errors[s.name] = e?.message || String(e)
    }
  }
  return Response.json({ source: null, time: Date.now(), planes: [], errors }, {
    status: 502,
    headers: { "Cache-Control": "no-store" },
  })
}

export const config: Config = { path: "/api/flights" }
