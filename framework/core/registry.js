export class ModuleRegistry {
  #modules = new Map();

  register(module) {
    if (this.#modules.has(module.id)) {
      throw new Error(`duplicate module id: ${module.id}`);
    }
    this.#modules.set(module.id, { ...module, status: 'registered' });
    return module.id;
  }

  get(id) {
    return this.#modules.get(id) ?? null;
  }

  list() {
    return [...this.#modules.values()].map((m) => ({
      id: m.id,
      version: m.version,
      status: m.status,
      services: m.services ?? [],
      listens: m.listens ?? [],
    }));
  }

  setStatus(id, status) {
    const m = this.#modules.get(id);
    if (m) m.status = status;
  }
}