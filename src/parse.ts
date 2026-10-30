/**
 * Reading what a peer, a guest or a file sends. A leaf module, so the protocol/ codecs and sessions.ts share it without
 * importing each other.
 */
import { z } from "zod";

/**
 * `value` as `schema` reads it. Otherwise throws one line that names each field that is wrong, from `what`, the name of
 * the whole value, and what is wrong with it, such as `command.timeoutMs: Too big: expected number to be <=60000`.
 */
export function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new Error(result.error.issues.map((issue) => `${what}${issue.path.map((key) => typeof key === "number" ? `[${key}]` : `.${String(key)}`).join("")}: ${issue.message}`).join("; "));
}

/** `parse` of JSON text. Text that is not JSON is wrong as a whole. */
export function parseJson<T>(schema: z.ZodType<T>, text: string, what: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`${what}: ${(err as Error).message}`);
  }
  return parse(schema, value, what);
}

/**
 * A schema that only checks, for a value handed on as its sender wrote it. zod would rebuild the value with the
 * schema's fields first, in the schema's order, so this hands on the value itself once the schema accepts it.
 */
export function asSent<T>(schema: z.ZodType<T>) {
  return z.unknown().transform((value, ctx) => {
    const result = schema.safeParse(value);
    if (result.success) return value as T;
    for (const issue of result.error.issues) ctx.issues.push({ ...issue, input: value } as z.core.$ZodRawIssue);
    return z.NEVER;
  });
}

/**
 * A field the receiver hands on without reading, so it is not checked. Its sender, of the same deploy or older, declares
 * it as `T`, and one that leaves it out is not refused.
 */
export const unchecked = <T>() => z.unknown().optional() as unknown as z.ZodType<T>;

export const nonEmpty = z.string().min(1);

/** A non-empty string, as the type `T` that names it. Nothing else about it is checked. */
export const named = <T extends string>() => nonEmpty.pipe(z.custom<T>());
