// F-4 应用内通知：批次结束提醒 HR（页面红点 + 通知列表），可选外发（预留）
import { randomBytes } from 'node:crypto';

export class NotificationService {
  constructor({ store, audit }) {
    this.store = store;
    this.audit = audit;
  }

  push({ type, title, body, data = null }) {
    const n = {
      id: `nt_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
      type, title, body, data, read: false,
      createdAt: new Date().toISOString(),
    };
    this.store.write('notifications.jsonl', n);
    this.audit?.record({ actor: 'system', action: `notify.${type}`, detail: { id: n.id, title } }).catch(() => {});
    return n;
  }

  list(limit = 50) {
    return this.store.readAll('notifications.jsonl').slice(-Math.max(1, Number(limit) || 50)).reverse();
  }

  unread() {
    return this.store.readAll('notifications.jsonl').filter((n) => !n.read);
  }

  markRead(id = 'all') {
    const rows = this.store.readAll('notifications.jsonl');
    let hit = 0;
    for (const n of rows) {
      if (id === 'all' ? !n.read : n.id === id) { n.read = true; hit++; }
    }
    this.store.writeAll('notifications.jsonl', rows);
    return { ok: true, marked: hit };
  }
}
