import { services, type Service } from "../control/services.ts";

/** The service as the control plane runs it: polled now and every `everyMs` until its close, which stops the polls. */
export function polled<S extends Service>(service: S): S {
  const running = services();
  running.start(service);
  return { ...service, close: () => running.close() };
}
