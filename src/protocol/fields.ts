/**
 * Probe contract, the fields that several message families share, and the base every codec builds on.
 *
 * - A peer of another release may send a field this one does not know, as during a deploy. It is not refused: a
 *   parser that hands its payload on hands the field on with it, and one that builds a value of its own leaves it out.
 *   A reported session event is the exception, checked as strictly as the pylon that sent it is, which only a probe
 *   newer than its control plane could break. Deploys upgrade the control plane first.
 * - A bad payload keeps its status (400, or the `invalid` submit reply) and gets one line that names each wrong field
 *   from the top of the payload, and what is wrong with it: `command.timeoutMs: Too big: expected number to be <=60000`.
 */
import { z } from "zod";
import { tailnetNodeIdPattern } from "../tailscale.ts";
import { named } from "../parse.ts";
import { isImageId, isTemplateId, maxPylonIdLength, type ImageId, type NodeName, type PylonId, type TailnetNodeId, type TemplateId } from "../ids.ts";

/** A tailnet machine name, which is one DNS label, so at most 63 characters. */
export const nodeNameSchema = z.string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "must be a lowercase tailnet machine name of at most 63 characters")
  .refine((name) => name !== "auto", "auto is what `start --node auto` asks for, so no node may be named it")
  .transform((name) => name as NodeName);
export const pylonIdSchema = z.string().max(maxPylonIdLength).regex(/^[a-z][a-z0-9-]*$/);

export const tailnetNodeIdSchema = z.string()
  .regex(tailnetNodeIdPattern, "must be a Tailscale stable node ID, such as nAbCdEf1CNTRL (tailscale status --json)")
  .transform((id) => id as TailnetNodeId);

export const imageId = z.string().pipe(z.custom<ImageId>(isImageId, "expected an image ID"));
export const templateId = z.string().pipe(z.custom<TemplateId>(isTemplateId, "expected a template ID"));

export const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected a hex sha256");
/** An object, whatever it holds, which the receiver hands on as `T`. */
export const objectAs = <T>() => z.custom<T>((value) => typeof value === "object" && value !== null && !Array.isArray(value), "expected an object");

export const pylonIdField = named<PylonId>();
