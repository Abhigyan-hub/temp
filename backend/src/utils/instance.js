import { randomUUID } from "node:crypto";

/** Unique per process; reported by /mailflow/health so a server can recognise its own responses. */
export const INSTANCE_ID = randomUUID();
