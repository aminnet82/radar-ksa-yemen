import type { Config } from "@netlify/functions"
import { collectAndSave } from "../lib/collect.mts"

// Background collector: one full round from all sources (about 15-25s), saved as the latest snapshot.
export default async () => {
  await collectAndSave(60_000)
}

export const config: Config = { background: true, path: "/api/collect" }
