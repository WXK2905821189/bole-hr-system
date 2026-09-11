export class Lifecycle {
  #tokens = new Map();

  constructor(registry, bus) {
    this.registry = registry;
    this.bus = bus;
  }

  async start(id) {
    const m = this.registry.get(id);
    if (!m) throw new Error(`module not found: ${id}`);
    const unsubs = [];
    if (m.instance?.onEvent) {
      for (const [evt] of m.listens ?? []) {
        unsubs.push(this.bus.on(evt, m.instance.onEvent.bind(m.instance, evt)));
      }
    }
    this.#tokens.set(id, { unsubs });
    this.registry.setStatus(id, 'running');
    return id;
  }

  async stop(id) {
    this.#tokens.get(id)?.unsubs.forEach((u) => u());
    this.#tokens.delete(id);
    this.registry.setStatus(id, 'stopped');
    return id;
  }
}