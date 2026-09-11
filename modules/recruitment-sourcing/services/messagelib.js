// 打招呼话术库：初次 / 二次激活 / 三次及以上激活 / 交换联系方式 四档
// 每档支持「BOSS直聘常用语(preset)」或「HR自定义(custom)」，多版本保存与切换（仅一版生效）。
// 数据写入 messagelib.jsonl，严格走 framework/schema/messagelib.schema.json 契约。
import { randomBytes } from 'node:crypto';

const TIERS = ['first', 'second', 'third', 'exchange'];
const CONTACT_PLACEHOLDER = '[我方联系方式]';

const PRESETS = {
  first: '您好，我是负责招聘的HR，看到您的简历与【[岗位]】岗位非常匹配，方便进一步了解一下您的最新情况吗？',
  second: '您好，此前曾就【[岗位]】机会向您打过招呼，若您方便的话，欢迎随时沟通，期待您的回复~',
  third: '您好，关于【[岗位]】的机会不知您是否仍有意向，若有任何疑问或考虑，欢迎随时与我沟通。',
  exchange: '您好，您的简历中暂未看到联系方式，为方便进一步沟通，我的联系方式是：[我方联系方式]，期待与您交换联系方式，谢谢！',
};

export class MessageLibraryService {
  constructor({ store, validate, audit, config }) {
    this.store = store;
    this.validate = validate;
    this.audit = audit;
    this.placeholder = config?.placeholder ?? '[岗位]';
    this.defaultContact = config?.hrContact ?? '138-0000-0000（BOSS 站内信）';
    if (!this.store.readAll('messagelib.jsonl').length) this.#seed();
  }

  // F-2：我方联系方式（话术渲染用），存 engagesettings.jsonl
  getHrContact() {
    const row = this.store.readAll('engagesettings.jsonl').find((x) => x.key === 'hrContact');
    return row?.value ?? this.defaultContact;
  }

  setHrContact(value) {
    const text = String(value ?? '').trim();
    if (!text) throw new Error('联系方式不能为空');
    const rows = this.store.readAll('engagesettings.jsonl').filter((x) => x.key !== 'hrContact');
    rows.push({ key: 'hrContact', value: text, updatedAt: new Date().toISOString() });
    this.store.writeAll('engagesettings.jsonl', rows);
    this.audit?.record({ actor: 'hr', action: 'engage.contact.update', detail: { value: text } }).catch(() => {});
    return text;
  }

  list() {
    return this.store.readAll('messagelib.jsonl').sort((a, b) => (a.tier === b.tier ? (a.updatedAt < b.updatedAt ? 1 : -1) : TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier)));
  }

  byTier(tier) {
    return this.list().filter((t) => t.tier === tier);
  }

  // 当前生效版本；无则落到该档常用语(preset)
  activeFor(tier) {
    const byTier = this.byTier(tier);
    return byTier.find((t) => t.active) ?? byTier.find((t) => t.source === 'preset') ?? byTier[0] ?? null;
  }

  // 保存新版本（多版本并存）。activate=true 时立即设为生效。
  create({ tier, source = 'custom', content, activate = false, note = '' }) {
    if (!TIERS.includes(tier)) throw new Error(`tier 需为 ${TIERS.join('/')}`);
    const text = String(content ?? '').trim();
    if (!text) throw new Error('话术内容不能为空');
    const template = {
      templateId: `msg_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
      tier, source: source === 'preset' ? 'preset' : 'custom',
      content: text, active: false, note: String(note ?? ''),
      updatedAt: new Date().toISOString(),
      meta: { createdAt: new Date().toISOString() },
    };
    const check = this.validate.validate('messagelib', template);
    if (!check.ok) throw new Error(`话术契约校验失败: ${check.errors.join('; ')}`);
    this.store.write('messagelib.jsonl', template);
    if (activate) this.activate(template.templateId);
    return this.store.readAll('messagelib.jsonl').find((t) => t.templateId === template.templateId);
  }

  // 切换生效版本：仅本档内其余版本置为不生效（各档独立生效）
  activate(templateId) {
    const list = this.store.readAll('messagelib.jsonl');
    const t = list.find((x) => x.templateId === templateId);
    if (!t) throw new Error('话术版本不存在');
    const now = new Date().toISOString();
    list.forEach((x) => { if (x.tier === t.tier) { x.active = x.templateId === templateId; x.updatedAt = now; } });
    this.store.writeAll('messagelib.jsonl', list);
    this.audit?.record({ actor: 'hr', action: 'messagelib.activate', detail: { templateId, tier: t.tier } }).catch(() => {});
    return list.find((x) => x.templateId === templateId);
  }

  // 换回该档常用语（preset）并启用
  setToPreset(tier) {
    if (!TIERS.includes(tier)) throw new Error(`tier 需为 ${TIERS.join('/')}`);
    let list = this.store.readAll('messagelib.jsonl');
    let preset = list.find((x) => x.tier === tier && x.source === 'preset');
    if (!preset) {
      preset = this.create({ tier, source: 'preset', content: PRESETS[tier], note: 'BOSS直聘常用语' });
      list = this.store.readAll('messagelib.jsonl');
    }
    list.forEach((x) => { x.active = x.templateId === preset.templateId && x.tier === tier; });
    this.store.writeAll('messagelib.jsonl', list);
    return list.find((x) => x.templateId === preset.templateId);
  }

  // 按触达轮次取档：第1轮初次(first)，第2轮二次激活(second)，>=3轮三次及以上(third)
  tierForRound(round) {
    return round <= 1 ? 'first' : round === 2 ? 'second' : 'third';
  }

  // 取生效话术并填充占位符：[岗位]→岗位名，[我方联系方式]→HR 联系方式（F-2 交换话术附我方联系方式）
  render(tier, jobTitle, round) {
    const t = this.activeFor(tier);
    if (!t) return { templateId: null, content: '' };
    const content = String(t.content)
      .split(this.placeholder).join(jobTitle || '岗位')
      .split(CONTACT_PLACEHOLDER).join(this.getHrContact());
    return { templateId: t.templateId, content, source: t.source };
  }

  #seed() {
    for (const tier of TIERS) {
      this.create({ tier, source: 'preset', content: PRESETS[tier], activate: true, note: 'BOSS直聘常用语' });
    }
  }
}