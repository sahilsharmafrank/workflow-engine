/** Queue that carries delayed resume messages back to the engine. */
export const DELAY_QUEUE = "wfe-delay";
/** Queue that carries external workers' replies back to the engine. */
export const RESPONSE_QUEUE = "wfe-response";

/** Request queue for an external service named in a step definition. */
export function serviceQueueName(service: string): string {
  return `wfe-service-${service}`;
}
