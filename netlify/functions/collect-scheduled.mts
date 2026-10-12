import type { Config } from "@netlify/functions"
import { collectAndSave } from "../lib/collect.mts"

// Fallback: keeps the snapshot fresh even when nobody is viewing (safety net every 10 minutes, 30s limit).
export default async () => {
  await collectAndSave(22_000)
}

export const config: Config = { schedule: "*/10 * * * *" }
