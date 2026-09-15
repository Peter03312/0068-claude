// 校验编排：
//   1) 结构与解析（成员、约束端点、表达式、引用只指前卡）
//   2) 约束合取可满足性（不可满足要单独报告，禁止真空蕴含）
//   3) 按卡片顺序：先查规则形状/前提，再在全部满足约束的图模型上查命题
//   4) 第一张错误卡即停，给出字典序最小反例、两侧取值与依赖链
//   5) 目标奇偶式同样在全部模型上检查
// 穷举可被 AbortToken 协作式取消（VerificationAborted 上抛）。

import type { Project, ProofCard } from './types';
import { MIN_MEMBERS, MAX_MEMBERS } from './types';
import { parseExpression, validateExprBounds, printExpr } from './expression';
import type { Expr } from './expression';
import type { GraphDef } from './linear';
import { linearize, evalLinear, listEdges } from './linear';
import { buildFixes, findWitness, findMinCounterexample } from './models';
import type { AbortToken, ConstraintFix } from './models';
import { checkRuleShape } from './rules';
import type { PremiseCard } from './rules';

export type Counterexample = number[]; // 每条边 0/1，按边字典序

export interface DependencyStep {
  cardId: string;
  /** 该卡在整个证明中的 1-based 序号 */
  ordinal: number;
  left: string;
  right: string;
  kind: ProofCard['kind'];
  rule: ProofCard['rule'];
  valueLeft: number;
  valueRight: number;
}

export interface CardError {
  cardId: string;
  kind: 'shape' | 'counterexample' | 'parse' | 'reference';
  message: string;
  counterexample?: Counterexample;
  valueLeft?: number;
  valueRight?: number;
  dependencyChain?: DependencyStep[];
}

export interface TargetVerdict {
  present: boolean;
  ok: boolean;
  message?: string;
  counterexample?: Counterexample;
  valueLeft?: number;
  valueRight?: number;
}

export interface VerificationReport {
  modelCount: number | null; // null = 无模型
  unsat: boolean;
  unsatReason?: string;
  witness?: number[];
  firstError: CardError | null;
  target: TargetVerdict;
  checkedCards: number;
  totalCards: number;
}

interface ParsedCard {
  card: ProofCard;
  left: Expr;
  right: Expr;
}

interface ParsedProject {
  def: GraphDef;
  fixes: ConstraintFix;
  modelCount: number;
  witness: number[];
  cards: ParsedCard[];
  target: { left: Expr; right: Expr } | null;
  targetParseError?: string;
}

type PrepareResult = { ok: true; parsed: ParsedProject } | { ok: false; report: VerificationReport };

function countModels(fixes: ConstraintFix): number {
  let free = 0;
  for (let i = 0; i < fixes.fixed.length; i += 1) {
    if (fixes.fixed[i] === -1) free += 1;
  }
  return 2 ** free;
}

function edgeLabel(a: number, b: number): string {
  return `x${String.fromCharCode(65 + a)}${String.fromCharCode(65 + b)}`;
}

export async function prepareProject(project: Project, signal?: AbortToken): Promise<PrepareResult> {
  const reportBase: VerificationReport = {
    modelCount: null,
    unsat: false,
    firstError: null,
    target: { present: false, ok: true },
    checkedCards: 0,
    totalCards: project.cards.length
  };

  if (project.memberCount < MIN_MEMBERS || project.memberCount > MAX_MEMBERS) {
    return {
      ok: false,
      report: {
        ...reportBase,
        unsat: true,
        unsatReason: `成员数必须在 ${MIN_MEMBERS}–${MAX_MEMBERS} 之间（当前 ${project.memberCount}）`
      }
    };
  }
  if (project.members.length !== project.memberCount || project.group.length !== project.memberCount) {
    return { ok: false, report: { ...reportBase, unsat: true, unsatReason: '成员名单或分组与成员数不一致' } };
  }
  if (project.group.some((g) => g !== 0 && g !== 1)) {
    return { ok: false, report: { ...reportBase, unsat: true, unsatReason: '分组只能为组 0 或组 1' } };
  }

  const def: GraphDef = { n: project.memberCount, group: project.group };

  for (const c of project.constraints) {
    if (c.a === c.b || c.a < 0 || c.b < 0 || c.a >= def.n || c.b >= def.n) {
      return { ok: false, report: { ...reportBase, unsat: true, unsatReason: '存在端点非法的边约束' } };
    }
  }

  const built = buildFixes(def.n, project.constraints);
  if ('conflict' in built) {
    const ed = built.conflict >= 0 ? listEdges(def.n)[built.conflict] : null;
    return {
      ok: false,
      report: {
        ...reportBase,
        unsat: true,
        unsatReason: ed
          ? `边 ${edgeLabel(ed.a, ed.b)} 同时被要求“必有”和“必无”，合取后无模型`
          : '边约束互相冲突，无模型'
      }
    };
  }
  const fixes = built.fixes;
  const witnessResult = await findWitness(def.n, fixes, signal);
  if (!witnessResult.sat) {
    return { ok: false, report: { ...reportBase, unsat: true, unsatReason: '边约束合取后不存在任何满足的图（无模型）' } };
  }

  // 解析所有卡片表达式
  const parsedCards: ParsedCard[] = [];
  for (const card of project.cards) {
    const lp = parseExpression(card.left);
    const rp = parseExpression(card.right);
    if (!lp.ok) {
      return failCard(reportBase, fixes, witnessResult.witness, card, 'parse', `左侧表达式：${lp.message}`);
    }
    if (!rp.ok) {
      return failCard(reportBase, fixes, witnessResult.witness, card, 'parse', `右侧表达式：${rp.message}`);
    }
    for (const [side, e] of [['左侧', lp.expr], ['右侧', rp.expr]] as [string, Expr][]) {
      const bound = validateExprBounds(e, def.n);
      if (bound) {
        return failCard(reportBase, fixes, witnessResult.witness, card, 'parse', `${side}表达式：${bound.message}`);
      }
    }
    parsedCards.push({ card, left: lp.expr, right: rp.expr });
  }

  // 引用合法性：必须存在、只引用更早卡片、不重复引用同卡
  const idToIndex = new Map<string, number>();
  parsedCards.forEach((pc, i) => idToIndex.set(pc.card.id, i));
  for (let i = 0; i < parsedCards.length; i += 1) {
    const pc = parsedCards[i];
    const seen = new Set<string>();
    for (const ref of pc.card.refs) {
      if (seen.has(ref)) {
        return failCard(reportBase, fixes, witnessResult.witness, pc.card, 'reference', '同一张前卡在引用中重复出现');
      }
      seen.add(ref);
      const j = idToIndex.get(ref);
      if (j === undefined) {
        return failCard(reportBase, fixes, witnessResult.witness, pc.card, 'reference', '引用了不存在的卡片');
      }
      if (j >= i) {
        return failCard(reportBase, fixes, witnessResult.witness, pc.card, 'reference', '只能引用排在本卡之前、已处理完的卡片');
      }
    }
  }

  // 目标式
  let target: { left: Expr; right: Expr } | null = null;
  let targetParseError: string | undefined;
  const tl = project.targetLeft.trim();
  const tr = project.targetRight.trim();
  if (tl !== '' || tr !== '') {
    if (tl === '' || tr === '') {
      targetParseError = '目标奇偶式两侧都必须填写（或同时留空表示暂不设定目标）';
    } else {
      const lpr = parseExpression(tl);
      const rpr = parseExpression(tr);
      if (!lpr.ok) targetParseError = `目标左侧：${lpr.message}`;
      else if (!rpr.ok) targetParseError = `目标右侧：${rpr.message}`;
      else {
        const bl = validateExprBounds(lpr.expr, def.n);
        const br = validateExprBounds(rpr.expr, def.n);
        if (bl) targetParseError = `目标左侧：${bl.message}`;
        else if (br) targetParseError = `目标右侧：${br.message}`;
        else target = { left: lpr.expr, right: rpr.expr };
      }
    }
  }

  return {
    ok: true,
    parsed: {
      def,
      fixes,
      modelCount: countModels(fixes),
      witness: witnessResult.witness,
      cards: parsedCards,
      target,
      targetParseError
    }
  };
}

function failCard(
  base: VerificationReport,
  fixes: ConstraintFix,
  witness: number[],
  card: ProofCard,
  kind: CardError['kind'],
  message: string
): PrepareResult {
  return {
    ok: false,
    report: {
      ...base,
      modelCount: countModels(fixes),
      witness,
      firstError: { cardId: card.id, kind, message }
    }
  };
}

function buildDependencyChain(pc: ParsedCard, byId: Map<string, ParsedCard>, ordinal: Map<string, number>, assignment: number[], def: GraphDef): DependencyStep[] {
  const chain: DependencyStep[] = [];
  const visited = new Set<string>();
  const walk = (cur: ParsedCard): void => {
    if (visited.has(cur.card.id)) return;
    visited.add(cur.card.id);
    for (const ref of cur.card.refs) {
      const pre = byId.get(ref);
      if (pre) walk(pre);
    }
    chain.push({
      cardId: cur.card.id,
      ordinal: ordinal.get(cur.card.id) ?? 0,
      kind: cur.card.kind,
      left: printExpr(cur.left),
      right: printExpr(cur.right),
      rule: cur.card.rule,
      valueLeft: evalLinear(linearize(cur.left, def), assignment),
      valueRight: evalLinear(linearize(cur.right, def), assignment)
    });
  };
  walk(pc);
  return chain;
}

/** 主校验：prepare 成功后逐卡检查；取消时抛 VerificationAborted */
export async function verifyProject(project: Project, signal?: AbortToken): Promise<VerificationReport> {
  const prepared = await prepareProject(project, signal);
  if (!prepared.ok) return prepared.report;
  const { def, fixes, modelCount, witness, cards, target, targetParseError } = prepared.parsed;
  const byId = new Map<string, ParsedCard>();
  cards.forEach((pc) => byId.set(pc.card.id, pc));
  const ordinal = new Map<string, number>();
  cards.forEach((pc, i) => ordinal.set(pc.card.id, i + 1));

  const stop: VerificationReport = {
    modelCount,
    unsat: false,
    witness,
    firstError: null,
    target: { present: false, ok: true },
    checkedCards: 0,
    totalCards: cards.length
  };

  for (let i = 0; i < cards.length; i += 1) {
    const pc = cards[i];
    const premises: PremiseCard[] = [];
    for (const ref of pc.card.refs) {
      const pre = byId.get(ref)!;
      premises.push({ card: pre.card, l: pre.left, r: pre.right });
    }

    const shape = checkRuleShape({ card: pc.card, curL: pc.left, curR: pc.right, premises, def });
    if (!shape.valid) {
      return { ...stop, checkedCards: i, firstError: { cardId: pc.card.id, kind: 'shape', message: shape.reason } };
    }

    const lL = linearize(pc.left, def);
    const lR = linearize(pc.right, def);
    const isParity = pc.card.kind === 'parity';
    const d = { constant: lL.constant - lR.constant, coeffs: lL.coeffs.map((c, k) => c - lR.coeffs[k]) };
    const counterexample = await findMinCounterexample(def.n, fixes, { d, kind: isParity ? 'parity' : 'equation' }, signal);
    if (counterexample) {
      return {
        ...stop,
        checkedCards: i,
        firstError: {
          cardId: pc.card.id,
          kind: 'counterexample',
          message: isParity
            ? '存在满足边约束的图使两侧奇偶不同（左侧减右侧为奇数）'
            : '存在满足边约束的图使等式两边不相等',
          counterexample,
          valueLeft: evalLinear(lL, counterexample),
          valueRight: evalLinear(lR, counterexample),
          dependencyChain: buildDependencyChain(pc, byId, ordinal, counterexample, def)
        }
      };
    }
  }

  let targetVerdict: TargetVerdict;
  if (targetParseError) {
    targetVerdict = { present: true, ok: false, message: targetParseError };
  } else if (target) {
    const lL = linearize(target.left, def);
    const lR = linearize(target.right, def);
    const d = { constant: lL.constant - lR.constant, coeffs: lL.coeffs.map((c, k) => c - lR.coeffs[k]) };
    const ce = await findMinCounterexample(def.n, fixes, { d, kind: 'parity' }, signal);
    targetVerdict = ce
      ? {
          present: true,
          ok: false,
          message: '目标奇偶式并非在所有满足约束的图上成立',
          counterexample: ce,
          valueLeft: evalLinear(lL, ce),
          valueRight: evalLinear(lR, ce)
        }
      : { present: true, ok: true };
  } else {
    targetVerdict = { present: false, ok: true };
  }

  return { ...stop, checkedCards: cards.length, target: targetVerdict };
}

export { printExpr };
