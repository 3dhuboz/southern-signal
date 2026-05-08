/**
 * Bootstrap helper — get-or-create today's investigation.
 * V1 simplification: one investigation per day until the user creates more.
 */

import { createInvestigation, listInvestigations } from "./db/repo";
import type { Investigation } from "./db/schema";

export async function ensureTodayInvestigation(): Promise<Investigation> {
  const all = await listInvestigations();
  const today = new Date().toISOString().slice(0, 10);
  const match = all.find((inv) => inv.created_at.startsWith(today) && inv.status !== "ended");
  if (match) return match;
  return createInvestigation({ title: `Investigation ${today}` });
}
