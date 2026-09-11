export class EventBus {
  #listeners = new Map();

  on(event, handler) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this.#listeners.get(event)?.delete(handler);
  }

  async emit(event, payload, meta = {}) {
    const handlers = [...(this.#listeners.get(event) ?? [])];
    const results = [];
    for (const h of handlers) {
      try {
        results.push(await h({ event, payload, meta }));
      } catch (err) {
        results.push({ error: err.message });
      }
    }
    return results;
  }
}