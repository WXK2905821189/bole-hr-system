// M5 · 密码安全：scrypt 散列存储（非明文）+ 复杂度策略 + 旧版明文自动升级
// 轻量安全：仅服务 5-6 个内网用户，选用同步 scrypt（Zero-dependency，无异步抖动）。
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const PREFIX = 'scrypt$';

// 复杂度策略：长度 >=6、同时含字母与数字、不得使用用户名、不得连续重复字符
export function pwPolicyError(password, username) {
  const p = String(password ?? '');
  if (p.length < 6) return '密码至少 6 位';
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return '密码需同时包含字母和数字';
  const uname = String(username ?? '').trim().toLowerCase();
  if (uname && p.toLowerCase().includes(uname)) return '密码不能包含用户名';
  if (/(.)\1{4,}/.test(p)) return '密码不能包含连续相同字符';
  return null;
}

// 生成版本化散列：scrypt$<saltB64url>$<hashB64url>
export function hashPw(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password ?? ''), salt, 32);
  return `${PREFIX}${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

// 校验：新格式走 scrypt 恒定时间比对；旧版明文走长度安全比对。
// 返回 { ok, legacy }——legacy=true 表示命中旧版明文，调用方应升级为散列。
export function verifyPw(password, stored) {
  const s = String(stored ?? '');
  if (!s) return { ok: false, legacy: false };
  if (!s.startsWith(PREFIX)) {
    return { ok: safeEqual(String(password ?? ''), s), legacy: true };
  }
  const parts = s.slice(PREFIX.length).split('$');
  if (parts.length !== 2) return { ok: false, legacy: false };
  const expected = Buffer.from(parts[1], 'base64url');
  const actual = scryptSync(String(password ?? ''), Buffer.from(parts[0], 'base64url'), expected.length);
  return { ok: timingSafeEqual(actual, expected), legacy: false };
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}