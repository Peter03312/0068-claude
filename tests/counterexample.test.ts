import { describe, it, expect } from 'vitest';
import { verifyProject } from '../src/domain/verifier';
import { emptyProject } from '../src/domain/types';
import type { Project } from '../src/domain/types';
import { parseExpression } from '../src/domain/expression';
import { linearize, evalLinear } from '../src/domain/linear';
import type { GraphDef } from '../src/domain/linear';
import { buildFixes, findMinCounterexample } from '../src/domain/models';

function base(overrides: Partial<Project> = {}): Project {
  return {
    ...emptyProject(),
    name: 't',
    memberCount: 3,
    members: ['a', 'b', 'c'],
    group: [0, 0, 1],
    ...overrides
  };
}

describe('counterexample reconstruction semantics', () => {
  it('a claimed non-identity equation fails on the reconstructed minimal assignment with recorded values', async () => {
    const project = base();
    const def: GraphDef = { n: 3, group: project.group };
    const built = buildFixes(3, []);
    if ('conflict' in built) throw new Error('conflict');

    // 假设一张卡错误地声称 deg(A) = xAB（漏掉 xAC）。
    // 形状检查会先拦下它；这里直接重建“若进入语义阶段”会得到的最小反例，
    // 并确认报告所用的取值口径（左/右线性化求值）与依赖链一致。
    const lExpr = parseExpression('deg(A)');
    const rExpr = parseExpression('xAB');
    if (!lExpr.ok || !rExpr.ok) throw new Error('parse');
    const lL = linearize(lExpr.expr, def);
    const lR = linearize(rExpr.expr, def);
    const d = { constant: lL.constant - lR.constant, coeffs: lL.coeffs.map((c, i) => c - lR.coeffs[i]) };
    const ce = await findMinCounterexample(3, built.fixes, { d, kind: 'equation' });
    expect(ce).toEqual([0, 1, 0]); // xAB=0,xAC=1,xBC=0：左 1、右 0
    expect(evalLinear(lL, ce!)).toBe(1);
    expect(evalLinear(lR, ce!)).toBe(0);
  });

  it('unsat constraint reports null modelCount and stops before any card verdict', async () => {
    const project = base({
      constraints: [
        { id: 'a', a: 0, b: 1, status: 'required' },
        { id: 'b', a: 0, b: 1, status: 'forbidden' }
      ],
      cards: [{ id: 'k1', kind: 'equation', left: 'deg(A)', right: 'xAB + xAC', rule: 'expand', refs: [] }]
    });
    const r = await verifyProject(project);
    expect(r.unsat).toBe(true);
    expect(r.modelCount).toBeNull();
    expect(r.firstError).toBeNull();
    expect(r.checkedCards).toBe(0);
  });

  it('2^free edge model count with 3 members and one required edge', async () => {
    const project = base({ constraints: [{ id: 'a', a: 0, b: 1, status: 'required' }] });
    const r = await verifyProject(project);
    expect(r.unsat).toBe(false);
    expect(r.modelCount).toBe(4); // 3 条边固定 1 条，剩 2 条自由
  });
});
