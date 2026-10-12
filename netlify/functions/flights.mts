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
  posTime: number // epoch ms of the position fix, used to keep the freshest report
}

const UA = { "User-Agent": "flight-radar-ksa-yemen/1.1 (netlify function)", Accept: "application/json" }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function getJSON(url: string, ms = 8000): Promise<any> {
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

function fromReadsb(a: any, now: number): Plane | null {
  if (a.lat == null || a.lon == null || !a.hex) return null
  const gnd = a.alt_baro === "ground"
  return {
    hex: String(a.hex).toLowerCase(), cs: (a.flight || "").trim(), reg: a.r || "", type: a.t || "", desc: a.desc || "",
    lat: a.lat, lon: a.lon,
    alt: gnd ? 0 : typeof a.alt_baro === "number" ? a.alt_baro : a.alt_geom ?? null, gnd,
    spd: a.gs ?? null, trk: a.track ?? a.true_heading ?? null, vs: a.baro_rate ?? a.geom_rate ?? null,
    sq: a.squawk || "",
    posTime: now - (a.seen_pos ?? a.seen ?? 0) * 1000,
  }
}

type Result = { name: string; planes: Plane[]; okPoints: number; totalPoints: number; error?: string }

// One request per point, spaced out so the free APIs don't answer 429.
// A point that gets 429 waits and is retried once.
async function readsbSource(name: string, url: (la: number, lo: number) => string, gapMs: number): Promise<Result> {
  const planes: Plane[] = []
  let okPoints = 0, lastErr = ""
  for (const [la, lo] of POINTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const j = await getJSON(url(la, lo), 7000)
        const now = typeof j.now === "number" ? (j.now > 1e12 ? j.now : j.now * 1000) : Date.now()
        for (const a of j.ac || j.aircraft || []) { const p = fromReadsb(a, now); if (p) planes.push(p) }
        okPoints++
        break
      } catch (e: any) {
        lastErr = e?.message || String(e)
        if (attempt === 0 && /429/.test(lastErr)) { await sleep(2000); continue }
        break
      }
    }
    await sleep(gapMs)
  }
  return { name, planes, okPoints, totalPoints: POINTS.length, error: okPoints < POINTS.length ? lastErr : undefined }
}

async function openSkySource(): Promise<Result> {
  try {
    const j = await getJSON(
      `https://opensky-network.org/api/states/all?lamin=${BBOX.s}&lomin=${BBOX.w}&lamax=${BBOX.n}&lomax=${BBOX.e}`,
      15000,
    )
    const planes: Plane[] = (j.states || []).filter((s: any[]) => s[0] && s[5] != null && s[6] != null).map((s: any[]) => ({
      hex: String(s[0]).toLowerCase(), cs: (s[1] || "").trim(), reg: "", type: "", desc: "", origin: s[2],
      lat: s[6], lon: s[5], alt: s[8] ? 0 : s[7] != null ? s[7] * 3.28084 : null, gnd: !!s[8],
      spd: s[9] != null ? s[9] * 1.94384 : null, trk: s[10], vs: s[11] != null ? s[11] * 196.85 : null, sq: s[14] || "",
      posTime: (s[3] ?? s[4] ?? j.time ?? Date.now() / 1000) * 1000,
    }))
    return { name: "OpenSky", planes, okPoints: 1, totalPoints: 1 }
  } catch (e: any) {
    return { name: "OpenSky", planes: [], okPoints: 0, totalPoints: 1, error: e?.message || String(e) }
  }
}

// Merge: keep the freshest position per aircraft, fill blanks (registration, type…) from other sources.
function merge(results: Result[]): Plane[] {
  const byHex = new Map<string, Plane>()
  const fill: (keyof Plane)[] = ["cs", "reg", "type", "desc", "sq", "origin"]
  for (const r of results) for (const p of r.planes) {
    if (p.lat < BBOX.s || p.lat > BBOX.n || p.lon < BBOX.w || p.lon > BBOX.e) continue
    const cur = byHex.get(p.hex)
    if (!cur) { byHex.set(p.hex, { ...p }); continue }
    const [fresh, other] = p.posTime > cur.posTime ? [{ ...p }, cur] : [cur, p]
    for (const k of fill) if (!fresh[k] && other[k]) (fresh as any)[k] = other[k]
    byHex.set(p.hex, fresh)
  }
  // drop positions older than 2 minutes
  const cutoff = Date.now() - 120_000
  return [...byHex.values()].filter((p) => p.posTime >= cutoff)
}

export default async (req: Request) => {
  const results = await Promise.all([
    readsbSource("adsb.lol", (la, lo) => `https://api.adsb.lol/v2/point/${la}/${lo}/250`, 1000),
    readsbSource("adsb.fi", (la, lo) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/250`, 1050),
    readsbSource("airplanes.live", (la, lo) => `https://api.airplanes.live/v2/point/${la}/${lo}/250`, 1050),
    openSkySource(),
  ])
  const planes = merge(results)
  const used = results.filter((r) => r.okPoints > 0)
  const sources = Object.fromEntries(results.map((r) => [r.name, {
    planes: r.planes.length, coverage: `${r.okPoints}/${r.totalPoints}`, ...(r.error ? { error: r.error } : {}),
  }]))
  if (!used.length) {
    return Response.json({ source: null, time: Date.now(), planes: [], sources, errors: Object.fromEntries(results.map((r) => [r.name, r.error || "no data"])) }, {
      status: 502, headers: { "Cache-Control": "no-store" },
    })
  }
  return Response.json(
    { source: used.map((r) => r.name).join(" + "), time: Date.now(), count: planes.length, planes, sources },
    {
      headers: {
        "Cache-Control": "public, max-age=0, must-revalidate",
        "Netlify-CDN-Cache-Control": "public, durable, s-maxage=15, stale-while-revalidate=45",
      },
    },
  )
}

export const config: Config = { path: "/api/flights" }
