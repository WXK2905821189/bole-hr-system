// 触达(Engagement)服务：每一次打招呼/索要简历/索要电话/跟进/回复记一条,
// 严格走 framework/schema/engagement.schema.json 契约校验, 合法后才写入 engagements.jsonl,
// 变异数据一律拒绝入库; 同时联动候选人 touchStatus(待触达/跟进中/已回复/沉睡).
import { randomBytes } from 'node:crypto';

const TOUCH_ACTIONS = ['greet', 'request_resume', 'request_phone', 'follow_up', 'agree_resume', 'exchange_contact'];
const FREQ_MODES = ['aggressive', 'balanced', 'conservative'];

export class EngagementService {
  constructor({ store, validate, audit, config }) {
    this.store = store;
    this.validate = validate;
    this.audit = audit;
    this.defaultMode = config?.touchFrequencyMode ?? 'balanced';
  }

  // 记录一次触达。必填：candidateId + action。契约校验失败抛错(不入库)。
  // F-1/F-2: agree_resume(同意收取简历) / exchange_contact(交换联系方式) 纳入同一触达体系
  touch({ candidateId, jobId, recruiterId = 'A1', action = 'greet', messageVersion,
          frequencyMode, replyContent, stopFlag = false, content }) {
    if (!candidateId) throw new Error('触达记录缺少 candidateId');
    const cands = this.store.readAll('candidates.jsonl');
    const c = cands.find((x) => x.candidateId === candidateId) ?? null;
    const now = new Date().toISOString();
    const jid = jobId ?? c?.jobId ?? '';
    const isReply = action === 'reply';

    const record = {
      engagementId: `eng_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
      candidateId,
      jobId: jid,
      recruiterId,
      action,
      touchCount: this.#count(candidateId) + 1,
      readStatus: isReply ? 'read' : 'unread',
      messageVersion: messageVersion || 'v1',
      timestamps: { sent: now, ...(isReply ? { replied: now } : {}) },
      meta: { createdAt: now, updatedAt: now },
    };
    if (content) record.content = String(content);
    if (frequencyMode) record.frequencyMode = FREQ_MODES.includes(frequencyMode) ? frequencyMode : this.defaultMode;
    else record.frequencyMode = this.defaultMode;
    if (stopFlag) record.stopFlag = true;
    if (isReply) {
      record.reply = { content: replyContent || '', receivedAt: now, intent: intentOf(replyContent) };
      record.timestamps.read = now;
    }

    // 契约校验：变异字段/缺字段导致不合法 => 拒绝入库并留痕
    const check = this.validate.validate('engagement', record);
    if (!check.ok) {
      this.#reject(record, check.errors);
      throw new Error(`触达记录契约校验失败: ${check.errors.join('; ')}`);
    }
    this.store.write('engagements.jsonl', record);
    this.#applyTouchStatus(candidateId, action, stopFlag, isReply);
    return record;
  }

  list(limit = 200) {
    return this.store.readAll('engagements.jsonl').slice(-limit);
  }

  byCandidate(candidateId) {
    return this.store.readAll('engagements.jsonl').filter((e) => e.candidateId === candidateId);
  }

  #count(candidateId) {
    return this.store.readAll('engagements.jsonl').filter((e) => e.candidateId === candidateId).length;
  }

  // 触达后联动候选人 touchStatus: 触达动作=>跟进中; 回复=>已回复(并唤醒沉睡, 清理粘滞标记); stop标记=>沉睡
  #applyTouchStatus(candidateId, action, stopFlag) {
    const cands = this.store.readAll('candidates.jsonl');
    const c = cands.find((x) => x.candidateId === candidateId);
    if (!c) return;
    if (stopFlag) c.touchStatus = 'sleeping', c.sleeping = true;
    else if (action === 'reply') { c.touchStatus = 'replied'; c.sleeping = false; c.sleepingAt = null; } // 回复即唤醒（标记保留但不再粘滞）
    else if (TOUCH_ACTIONS.includes(action)) c.touchStatus = 'engaging';
    else if (!c.touchStatus) c.touchStatus = 'pending';
    this.store.writeAll('candidates.jsonl', cands);
  }

  // 变异拒绝留痕(写入 guardrail.jsonl + 审计), 保证"不入库"可追溯
  #reject(record, errors) {
    const row = { at: new Date().toISOString(), kind: 'engagement.validate.reject', candidateId: record.candidateId, action: record.action, errors };
    this.store.write('guardrail.jsonl', row);
    this.audit?.record({ actor: record.recruiterId, action: 'engagement.reject', detail: { candidateId: record.candidateId, errors } }).catch(() => {});
  }
}

// 简单意图判定：含拒绝词 => reject, 含提问 => question, 肯定/含糊 => accept
function intentOf(content = '') {
  const s = String(content);
  if (/谢绝|不感兴|不考虑|暂不|没时间|不合适/.test(s)) return 'reject';
  if (/薪资|薪资|福利|地点|工作内容|几点|什么|吗/.test(s)) return 'question';
  return 'accept';
}