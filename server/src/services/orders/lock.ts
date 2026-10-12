import type { Env } from '../../env';
import type { OrderLock } from '../../durable-objects/OrderLock';

/** The OrderLock instance for `key` (`listing:<id>`, `order:<id>` or `cron:<name>`). */
export function orderLock(env: Env, key: string) {
  const ns = env.ORDER_LOCK as DurableObjectNamespace<OrderLock>;
  return ns.get(ns.idFromName(key));
}
