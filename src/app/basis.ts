// 为每张卡给出“规则依据”的纯同步说明（不做模型穷举，供界面展示）。
// 与 worker 的全量校验一致地调用同一个规则形状检查器。

import type { Project } from '../domain/types';
import { parseExpression, validateExprBounds } from '../domain/expression';
import type { Expr } from '../domain/expression';
import { checkRuleShape } from '../domain/rules';
import type { PremiseCard } from '../domain/rules';
import type { GraphDef } from '../domain/linear';

export interface CardBasis {
  ok: boolean;
  reason: string;
}

export function describeCardBases(project: Project): Map<string, CardBasis> {
  const result = new Map<string, CardBasis>();
  const def: GraphDef = { n: project.memberCount, group: project.group };
  const parsed: { id: string; kind: Project['cards'][number]['kind']; refs: string[]; l: Expr | null; r: Expr | null }[] = [];

  for (const card of project.cards) {
    const lp = parseExpression(card.left);
    const rp = parseExpression(card.right);
    parsed.push({
      id: card.id,
      kind: card.kind,
      refs: card.refs,
      l: lp.ok ? lp.expr : null,
      r: rp.ok ? rp.expr : null
    });
  }
  const byId = new Map(parsed.map((p) => [p.id, p]));

  project.cards.forEach((card, i) => {
    const p = parsed[i];
    if (!p.l || !p.r) {
      result.set(card.id, { ok: false, reason: '表达式未通过解析，无法核对规则依据' });
      return;
    }
    for (const e of [p.l, p.r]) {
      const bound = validateExprBounds(e, def.n);
      if (bound) {
        result.set(card.id, { ok: false, reason: bound.message });
        return;
      }
    }
    const premises: PremiseCard[] = [];
    let refBroken = false;
    for (const ref of card.refs) {
      const j = project.cards.findIndex((c) => c.id === ref);
      if (j < 0 || j >= i) {
        refBroken = true;
        break;
      }
      const preParsed = byId.get(ref)!;
      if (!preParsed.l || !preParsed.r) {
        refBroken = true;
        break;
      }
      premises.push({ card: project.cards[j], l: preParsed.l, r: preParsed.r });
    }
    if (refBroken) {
      result.set(card.id, { ok: false, reason: '引用前提不合法或尚未能解析' });
      return;
    }
    const verdict = checkRuleShape({ card, curL: p.l, curR: p.r, premises, def });
    result.set(card.id, { ok: verdict.valid, reason: verdict.reason });
  });

  return result;
}

export const RULE_LABELS: Record<string, string> = {
  expand: '展开度数',
  regroup: '按边归组',
  substitute: '引用已证等式代换',
  addsub: '等式两边同加减',
  transitive: '等式传递',
  parity: '由 X=2Y+Z 推同奇偶'
};

export const STATUS_LABELS: Record<string, string> = {
  required: '必有',
  forbidden: '必无',
  unknown: '待定'
};
