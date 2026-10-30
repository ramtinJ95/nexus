/**
 * The preview rules both services supervisors share, the pylon VM's (src/pylon-vm/services.ts) and the Docker
 * double's (src/docker-services.ts), so the double refuses what a pylon refuses, in the same words. Each keeps
 * its own I/O. The pylon controller loads this file with type stripping, so it imports no values but project.ts's.
 */
import { linkedName, reservedPorts } from "./project.ts";
import type { ServiceName } from "./project.ts";
import type { ServiceFact } from "./protocol.ts";

/** A supervised service, as the preview rules see it. `previewed` is whether it publishes a preview. */
export interface PreviewService {
  name: ServiceName;
  port: number;
  previewed: boolean;
  declared: boolean;
}

/** What linking `port` previews: the service that owns it, a refusal with why, or a new linked port. */
export function linkTarget(port: number, services: readonly PreviewService[], configPath: string): { service: ServiceName } | { refused: string } | "link" {
  if (reservedPorts.has(port)) return { refused: `Port ${port} is Nexus's own, so it cannot be previewed` };
  const owner = services.find((service) => service.port === port);
  if (owner) {
    if (!owner.previewed) return { refused: `Port ${port} belongs to service ${owner.name}, which has no preview. Declare one in ${configPath}` };
    return { service: owner.name };
  }
  if (services.some((service) => service.name === linkedName(port)))
    return { refused: `Service ${linkedName(port)} runs on another port, so port ${port} cannot be previewed under that name. Rename the service` };
  return "link";
}

/**
 * Why a port that is not linked cannot be unlinked: a service's preview publishes it, which only the service's
 * declaration can drop, or a service holds its linked name, because the caller drops the preview of that name.
 * Null for any other port, which is left as it is.
 */
export function unlinkRefusal(port: number, services: readonly PreviewService[], configPath: string): string | null {
  const owner = services.find((service) => service.port === port && service.previewed);
  if (owner)
    return `Port ${port} is the preview of service ${owner.name}, not a linked port. ${owner.declared ? `Remove the preview from ${configPath} to unpublish it` : "An ad hoc service keeps its preview"}`;
  return services.some((service) => service.name === linkedName(port))
    ? `Service ${linkedName(port)} is not a linked port, so port ${port} has no linked preview to unpublish. Rename the service`
    : null;
}

/** `healthy` counts only while the service runs. A watched start is starting even once its process has exited, until its watch fails it. */
export function serviceState({ running, healthy, failed, watched }: { running: boolean; healthy: boolean; failed: boolean; watched: boolean }): ServiceFact["state"] {
  return running && healthy ? "ready" : failed ? "failed" : running || watched ? "starting" : "stopped";
}
