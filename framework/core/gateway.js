// 统一网关：HTTP 路由 + 审计 + 共享令牌鉴权
// 鉴权模型：公开路径（health/静态前端/模块元信息）放行；其余数据/导出接口在配置了 auth.token 时要求 Bearer 令牌。
// 认证成功的请求，audit.actor 取认证身份（auth.actor），不再信任客户端可伪造的 x-actor 头。
import { createServer } from 'node:http';

export class Gateway {
  constructor({ registry, audit, auth = {} }) {
    this.registry = registry;
    this.audit = audit;
    this.auth = { token: auth.token ?? '', actor: auth.actor ?? 'hr' };
    this.routes = new Map();
    this.publicPaths = [
      { method: 'GET', path: '/health' },
      { method: 'GET', path: '/' },
      { method: 'GET', path: '/index.html' },
      { method: 'GET', path: '/modules' },
    ];
  }

  route(method, pathRegex, handler) {
    this.routes.set(`${method} ${pathRegex.source}`, { method, pathRegex, handler });
  }

  #isPublic(method, path) {
    return this.publicPaths.some((p) => p.method === method && p.path === path);
  }

  #token(req) {
    const h = req.headers['authorization'] ?? '';
    if (h.startsWith('Bearer ')) return h.slice(7).trim();
    return String(req.headers['x-auth-token'] ?? '').trim();
  }

  #authed(req) {
    if (!this.auth.token) return true; // 未配置令牌 → 保持开放（启动时告警），供内部调试
    return this.#token(req) === this.auth.token;
  }

  // actor 来源：公开请求=anonymous；配置令牌后=认证身份；开放模式下沿用调用方标称（仅作标签）
  #actor(req, isPublic) {
    if (isPublic) return 'anonymous';
    if (this.auth.token) return this.auth.actor;
    return req.headers['x-actor'] ?? 'anonymous';
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const isPublic = this.#isPublic(req.method, path);

    if (!isPublic && !this.#authed(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'WWW-Authenticate': 'Bearer realm="hr"' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      await this.audit?.record?.({ actor: 'auth', action: 'auth.failed', detail: { method: req.method, path } });
      return;
    }
    const actor = this.#actor(req, isPublic);
    const match = [...this.routes.values()].find((r) => r.method === req.method && r.pathRegex.test(path));
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'route not found' }));
      return;
    }
    await this.audit.record({ actor, action: `${req.method} ${path}` });
    await match.handler(req, res, url);
  }

  listen(port = 0) {
    this.server = createServer((req, res) => this.handle(req, res));
    return this.server.listen(port);
  }
}