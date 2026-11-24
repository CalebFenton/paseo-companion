import type { PluginSubscriptionContext } from "@getpaseo/plugin/server";

interface Subscriber<Input, Event> {
  input: Input;
  context: PluginSubscriptionContext<Event>;
  /** The last event pushed, as JSON, so an unchanged view is not sent again. */
  sent: string | null;
  /** One send at a time, so a slow compute cannot land after a newer one. */
  queue: Promise<void>;
}

/**
 * The subscribers to one plugin subscription. Each gets what `compute` makes of its own input on
 * subscribing, then on every `publish` that changed it, with its own context, the same one each time.
 * A failed compute leaves it the last one.
 */
export function createFeed<Input, Event>(
  name: string,
  compute: (input: Input, context: PluginSubscriptionContext<Event>) => Event | Promise<Event>,
) {
  const subscribers = new Set<Subscriber<Input, Event>>();

  const deliver = async (subscriber: Subscriber<Input, Event>) => {
    if (subscriber.context.signal.aborted) return;
    try {
      const event = await compute(subscriber.input, subscriber.context);
      const json = JSON.stringify(event);
      if (json === subscriber.sent) return;
      subscriber.sent = json;
      await subscriber.context.push(event);
    } catch (error) {
      console.error(`${name}: computing an event failed`, error);
    }
  };
  const send = (subscriber: Subscriber<Input, Event>) => {
    subscriber.queue = subscriber.queue.then(() => deliver(subscriber));
  };

  return {
    handle: (input: Input, context: PluginSubscriptionContext<Event>): void => {
      const subscriber: Subscriber<Input, Event> = { input, context, sent: null, queue: Promise.resolve() };
      subscribers.add(subscriber);
      context.signal.addEventListener(
        "abort",
        () => {
          subscribers.delete(subscriber);
        },
        { once: true },
      );
      send(subscriber);
    },
    publish: (): void => {
      for (const subscriber of subscribers) send(subscriber);
    },
  };
}
