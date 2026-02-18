import { and, eq } from "drizzle-orm";

import { getDb } from "./index.js";
import { cronJobs } from "./schema.js";

type CronJobRow = typeof cronJobs.$inferSelect;

function upsertCronJob(
  agentSlug: string,
  jobId: string,
  data: {
    type: string;
    config?: string;
    lastRun?: string;
    nextRun?: string;
    status?: string;
    retryCount?: number;
    createdAt: string;
  },
): void {
  const db = getDb();
  db.insert(cronJobs)
    .values({
      agentSlug,
      config: data.config,
      createdAt: data.createdAt,
      jobId,
      lastRun: data.lastRun,
      nextRun: data.nextRun,
      retryCount: data.retryCount ?? 0,
      status: data.status ?? "pending",
      type: data.type,
    })
    .onConflictDoUpdate({
      set: {
        config: data.config,
        lastRun: data.lastRun,
        nextRun: data.nextRun,
        retryCount: data.retryCount ?? 0,
        status: data.status ?? "pending",
        type: data.type,
      },
      target: [cronJobs.agentSlug, cronJobs.jobId],
    })
    .run();
}

function getCronJob(agentSlug: string, jobId: string): CronJobRow | undefined {
  const db = getDb();
  return db
    .select()
    .from(cronJobs)
    .where(and(eq(cronJobs.agentSlug, agentSlug), eq(cronJobs.jobId, jobId)))
    .get();
}

function getAgentCronJobs(agentSlug: string): CronJobRow[] {
  const db = getDb();
  return db.select().from(cronJobs).where(eq(cronJobs.agentSlug, agentSlug)).all();
}

function deleteCronJob(agentSlug: string, jobId: string): void {
  const db = getDb();
  db.delete(cronJobs)
    .where(and(eq(cronJobs.agentSlug, agentSlug), eq(cronJobs.jobId, jobId)))
    .run();
}

function updateLastRun(agentSlug: string, jobId: string, timestamp: string): void {
  const db = getDb();
  db.update(cronJobs)
    .set({ lastRun: timestamp })
    .where(and(eq(cronJobs.agentSlug, agentSlug), eq(cronJobs.jobId, jobId)))
    .run();
}

export type { CronJobRow };
export { deleteCronJob, getAgentCronJobs, getCronJob, updateLastRun, upsertCronJob };
