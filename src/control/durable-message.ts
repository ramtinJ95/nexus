/** A message saved before its first send, under the request ID every send of it uses. */
export interface DurableMessage { id: string; text: string }

/**
 * Sends a saved message and returns what `clear` returns once the receiver took it, or null when it could not take it
 * yet. The message stays saved until `clear` runs, so a later pass, or the first after a crash, sends it again under the
 * same request ID, which the receiver never takes twice.
 */
export async function deliverDurable<T>(message: DurableMessage, send: (message: DurableMessage) => Promise<"delivered" | "later">, clear: () => T): Promise<T | null> {
  return await send(message) === "delivered" ? clear() : null;
}
