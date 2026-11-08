/** The request schemas of the routes in reports.ts. They need zod, so they stay out of reports.ts, which a browser can bundle. */
import { z } from "zod";

export const checksSeenSchema = z.strictObject({ through: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
