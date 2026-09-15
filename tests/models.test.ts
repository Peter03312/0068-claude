import { describe, it, expect } from 'vitest';
import { buildFixes, findWitness, findMinCounterexample } from '../src/domain/models';
import type { EdgeConstraint } from '../src/domain/types';

const c = (a: number, b: number, status: EdgeConstraint['status']): EdgeConstraint => ({ id: `${a}-${b}-${status}`, a, b, status });

describe('constraint conjunction', () => {
  it('flags same edge required and forbidden as conflict', () => {
    const built = buildFixes(3, [c(0, 1, 'required'), c(1, 0, 'forbidden')]);
    expect('conflict' in built).toBe(true);
  });

  it('duplicate consistent constraints are fine', () => {
    const built = buildFixes(3, [c(0, 1, 'required'), c(0, 1, 'required')]);
    expect('fixes' in built).toBe(true);
  });

  it('unknown constraints never restrict', async () => {
    const built = buildFixes(3, [c(0, 1, 'unknown')]);
    if ('conflict' in built) throw new Error('unexpected conflict');
    const w = await findWitness(3, built.fixes);
    expect(w.sat).toBe(true);
    if (w.sat) expect(w.witness).toEqual([0, 0, 0]); // 字典序最小见证
  });
});

describe('minimal counterexample order', () => {
  const d = (constant: number, coeffs: number[]) => ({ constant, coeffs });

  it('finds the lexicographically smallest failing assignment (0 before 1)', async () => {
    const built = buildFixes(2, []);
    if ('conflict' in built) throw new Error('conflict');
    // 等式 xAB = 1 的差式 xAB - 1：在 xAB=0 时残差 -1≠0 ⇒ 最小反例 [0]
    const ce = await findMinCounterexample(2, built.fixes, { d: d(-1, [1]), kind: 'equation' });
    expect(ce).toEqual([0]);
  });

  it('returns null when the equation holds on every model', async () => {
    const built = buildFixes(3, []);
    if ('conflict' in built) throw new Error('conflict');
    const dZero = { constant: 0, coeffs: [0, 0, 0] };
    const ce = await findMinCounterexample(3, built.fixes, { d: dZero, kind: 'equation' });
    expect(ce).toBeNull();
  });

  it('lexicographic minimum over free edges respects ordering', async () => {
    // 固定 xAB=1，xAC 自由，xBC 自由；目标恒为假时找最小：自由位从 0 开始
    const built = buildFixes(3, [c(0, 1, 'required')]);
    if ('conflict' in built) throw new Error('conflict');
    // 失败条件：xAC + xBC ≠ 0 时失败，最小反例 [1, 0, 1]?
    // xAB 固定=1；让 d = xAC + xBC，失败 ⇔ d≠0，最小 = [1,0,1]（xAC=0,xBC=1）
    const ce = await findMinCounterexample(3, built.fixes, { d: d(0, [0, 1, 1]), kind: 'equation' });
    expect(ce).toEqual([1, 0, 1]);
  });

  it('parity counterexample requires an odd residual', async () => {
    const built = buildFixes(2, [c(0, 1, 'required')]);
    if ('conflict' in built) throw new Error('conflict');
    // xAB ≡ 0 在 xAB=1 时奇偶失败
    const ce = await findMinCounterexample(2, built.fixes, { d: d(0, [1]), kind: 'parity' });
    expect(ce).toEqual([1]);
  });
});
