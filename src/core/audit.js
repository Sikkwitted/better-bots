import { JsonlLog } from './store.js';
import { newId } from './util.js';

// Every external or destructive side effect has an
// authorization decision and an audit record. Every service writes here.
export class AuditLog {
  constructor({ file, clock }) {
    this.log = new JsonlLog(file);
    this.clock = clock;
    this.subscribers = new Set();
  }

  /** The interface layer watches activity live. Returns an unsubscribe function. */
  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  record(type, data = {}) {
    const event = this.log.append({ ...data, id: newId('aud'), type, at: this.clock.iso() });
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        // A broken watcher must never break the thing it is watching.
      }
    }
    return event;
  }

  all() {
    return this.log.readAll();
  }

  tail(n = 50) {
    return this.log.tail(n);
  }

  where(predicate) {
    return this.log.readAll().filter(predicate);
  }
}
