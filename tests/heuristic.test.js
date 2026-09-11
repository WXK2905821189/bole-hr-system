// matcher 离线启发式打分 —— 锚定输出边界与确定性，防口径漂移
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heuristic } from '../modules/recruitment-sourcing/services/matcher.js';

const jobWeCanMatch = {
  hard_skills: ['JavaScript', 'React'],
  soft_skills: ['沟通', '协作'],
  core_duties: ['前端开发'],
  keywords: ['前端', 'JavaScript'],
};
const resume_js = { skills: ['JavaScript', 'React', 'Node.js', 'Vue'] };
const resume_unrelated = { skills: ['Go', 'Docker', 'Kubernetes'] };

test('heuristic：返回 0..100 的整数 match_score', () => {
  const r = heuristic(jobWeCanMatch, resume_js);
  assert.equal(Number.isInteger(r.match_score), true);
  assert.ok(r.match_score >= 0 && r.match_score <= 100);
});

test('heuristic：产出五个维度分数，键完整', () => {
  const r = heuristic(jobWeCanMatch, resume_js);
  for (const dim of ['hard_skills', 'soft_skills', 'core_duties', 'industry_experience', 'education']) {
    assert.ok(dim in r.dimension_scores);
  }
});

test('heuristic：技术栈匹配的简历得分不低于无关简历', () => {
  const hi = heuristic(jobWeCanMatch, resume_js).match_score;
  const lo = heuristic(jobWeCanMatch, resume_unrelated).match_score;
  assert.ok(hi >= lo, `匹配者(${hi})应不低于无关者(${lo})`);
});

test('heuristic：相同输入结果确定性一致（可回归断言）', () => {
  assert.equal(heuristic(jobWeCanMatch, resume_js).match_score, heuristic(jobWeCanMatch, resume_js).match_score);
});