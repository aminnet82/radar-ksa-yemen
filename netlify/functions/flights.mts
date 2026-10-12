import type { Config, Context } from "@netlify/functions"
import { store, type Snapshot } from "../lib/collect.mts"

// Fast read: returns the latest saved snapshot. If it is getting old,
// kicks the background collector (at most once per 30s) without waiting for it.
const STALE_MS = 15_000
const LOCK_MS = 30_000

export default async (req: Request, context: Context) => {
  const s = store()
  const [snap, lock] = await Promise.all([
    s.get("latest", { type: "json" }).catch(() => null) as Promise<Snapshot | null>,
    s.get("lock", { type: "json" }).catch(() => null) as Promise<{ at: number } | null>,
  ])
  const now = Date.now()
  const stale = !snap || now - snap.time > STALE_MS
  if (stale && (!lock || now - lock.at > LOCK_MS)) {
    await s.setJSON("lock", { at: now })
    const url = new URL("/api/collect", req.url)
    context.waitUntil(fetch(url, { method: "POST" }).catch(() => {}))
  }
  if (!snap) {
    return Response.json({ warming: true, time: now, planes: [] }, { status: 503, headers: { "Cache-Control": "no-store" } })
  }
  return Response.json({ ...snap, age: now - snap.time }, {
    headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, durable, s-maxage=5, stale-while-revalidate=10",
    },
  })
}

export const config: Config = { path: "/api/flights" }
