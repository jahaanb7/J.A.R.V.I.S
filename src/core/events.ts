export type BusEventType =
  | 'message.added'
  | 'calendar.changed'
  | 'tasks.changed'
  | 'memory.added'
  | 'approval.requested'
  | 'approval.resolved'
  | 'audit.recorded'
  | 'system.paused'
  | 'system.resumed'
  | 'widgets.changed';

export interface BusEvent {
  type: BusEventType;
  payload: unknown;
  ts: string;
}

export type BusHandler = (event: BusEvent) => void;

export class EventBus {
  private readonly handlers = new Set<BusHandler>();

  publish(type: BusEventType, payload: unknown = null): void {
    const event: BusEvent = { type, payload, ts: new Date().toISOString() };
    for (const handler of [...this.handlers]) {
      try {
        handler(event);
      } catch (err) {
        // A failing subscriber must never break the component that published the event.
        console.error(`event handler failed for ${type}`, err);
      }
    }
  }

  subscribe(handler: BusHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}
