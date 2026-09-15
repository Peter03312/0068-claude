// 图模型穷举：
//   边按 (a,b) 字典序（成员序列，0<1）编号；每条边取 0/1。
//   required 边固定为 1，forbidden 边固定为 0，unknown 边自由；
//   同一条边被重复约束时取合取：同时被 required 与 forbidden ⇒ 立即无模型。
//
// DFS 沿边编号从小到大、每边先试 0 再试 1，因此找到的第一个可行赋值
// 就是字典序最小的反例。两条剪枝：
//   等式 d=0：用自由边系数给出后缀最小/最大可达值，区间恒正或恒负则剪枝；
//   奇偶 d≡0：后缀贡献无法让当前残差变为偶数则剪枝。
//
// 搜索为可中断的 async：每隔 YIELD_BUDGET 个节点让出事件循环一次，
// 使 worker 能在快速编辑时收到更新的任务/取消信号。

import type { EdgeConstraint } from './types';
import { edgeIndexOf } from './linear';
import type { Linear } from './linear';

export interface AbortToken {
  cancelled: boolean;
}
export class VerificationAborted extends Error {
  constructor() {
    super('verification aborted');
    this.name = 'VerificationAborted';
  }
}

const YIELD_BUDGET = 4096;

export interface ConstraintFix {
  /** -1 = 自由；0 = 固定 0；1 = 固定 1 */
  fixed: Int8Array;
}

export function buildFixes(n: number, constraints: EdgeConstraint[]): { fixes: ConstraintFix } | { conflict: number } {
  const m = (n * (n - 1)) / 2;
  const fixed = new Int8Array(m).fill(-1);
  for (const c of constraints) {
    if (c.a === c.b || c.a < 0 || c.b < 0 || c.a >= n || c.b >= n) {
      return { conflict: -1 }; // 非法端点在项目层拦截，这里保守处理
    }
    const idx = edgeIndexOf(c.a, c.b, n);
    const want = c.status === 'required' ? 1 : c.status === 'forbidden' ? 0 : -1;
    if (want === -1) continue; // 待定不限制
    if (fixed[idx] !== -1 && fixed[idx] !== want) {
      return { conflict: idx }; // 同边合取冲突：既有必有又有必无
    }
    fixed[idx] = want;
  }
  return { fixes: { fixed } };
}

export type SatResult = { sat: true; witness: number[] } | { sat: false };

class Throttle {
  private nodes = 0;
  constructor(private readonly signal?: AbortToken) {}
  /** 同步快速检查：取消即时生效；到达预算点时返回 true，调用方再 await 让出。 */
  check(): boolean {
    if (this.signal?.cancelled) throw new VerificationAborted();
    this.nodes += 1;
    return this.nodes % YIELD_BUDGET === 0;
  }
  async yield(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (this.signal?.cancelled) throw new VerificationAborted();
  }
}

/** 约束是否可满足（任一模型） */
export async function findWitness(
  n: number,
  fixes: ConstraintFix,
  signal?: AbortToken
): Promise<SatResult> {
  const m = (n * (n - 1)) / 2;
  const assign = new Array<number>(m).fill(0);
  const throttle = new Throttle(signal);
  const dfs = async (i: number): Promise<boolean> => {
    if (i === m) return true;
    if (throttle.check()) await throttle.yield();
    const f = fixes.fixed[i];
    if (f !== -1) {
      assign[i] = f;
      return dfs(i + 1);
    }
    assign[i] = 0;
    if (await dfs(i + 1)) return true;
    assign[i] = 1;
    return dfs(i + 1);
  };
  const ok = await dfs(0);
  return ok ? { sat: true, witness: assign.slice() } : { sat: false };
}

interface Target {
  d: Linear;
  kind: 'equation' | 'parity';
}

/** 后缀可达区间（仅统计自由边），用于等式剪枝 */
function suffixBounds(d: Linear, fixed: Int8Array, from: number): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (let i = from; i < d.coeffs.length; i += 1) {
    if (fixed[i] !== -1) continue;
    const c = d.coeffs[i];
    if (c > 0) max += c;
    else if (c < 0) min += c;
  }
  return { min, max };
}

/**
 * 在满足约束的模型中，找字典序最小的、使目标不成立的赋值：
 *   equation：d(assignment) ≠ 0
 *   parity：  d(assignment) 为奇数
 * 返回 null 表示目标在所有模型上成立。
 */
export async function findMinCounterexample(
  n: number,
  fixes: ConstraintFix,
  target: Target,
  signal?: AbortToken
): Promise<number[] | null> {
  const m = (n * (n - 1)) / 2;
  const assign = new Array<number>(m).fill(0);
  const throttle = new Throttle(signal);

  const canFail = (from: number, residual: number): boolean => {
    if (target.kind === 'equation') {
      // 失败 ⇔ 最终残差 ≠ 0。剩余固定边贡献确定；自由边给出可达区间 [min,max]。
      let fixedTail = 0;
      for (let i = from; i < m; i += 1) {
        const f = fixes.fixed[i];
        if (f !== -1) fixedTail += target.d.coeffs[i] * f;
      }
      const { min, max } = suffixBounds(target.d, fixes.fixed, from);
      const lo = residual + fixedTail + min;
      const hi = residual + fixedTail + max;
      // 最终可能值覆盖 [lo,hi]。只有当 0 是唯一可能值时才不可能失败。
      return !(lo === 0 && hi === 0);
    }
    // parity：失败 ⇔ 最终残差为奇数
    if (Math.abs(residual) % 2 === 1) return true;
    let fixedTailParity = 0;
    for (let i = from; i < m; i += 1) {
      const f = fixes.fixed[i];
      if (f !== -1) fixedTailParity ^= Math.abs(target.d.coeffs[i] * f) % 2;
    }
    if (fixedTailParity === 1) return true;
    for (let i = from; i < target.d.coeffs.length; i += 1) {
      if (fixes.fixed[i] === -1 && Math.abs(target.d.coeffs[i]) % 2 === 1) return true;
    }
    return false;
  };

  const dfs = async (i: number, residual: number): Promise<boolean> => {
    if (i === m) {
      if (target.kind === 'equation') return residual !== 0;
      return Math.abs(residual) % 2 === 1;
    }
    if (throttle.check()) await throttle.yield();
    const f = fixes.fixed[i];
    if (f !== -1) {
      const next = residual + target.d.coeffs[i] * f;
      assign[i] = f;
      // 固定边无选择：剩余部分只要可能失败就继续，不能在当前位提前判定
      if (canFail(i + 1, next)) return dfs(i + 1, next);
      return false;
    }
    for (const val of [0, 1]) {
      const next = residual + target.d.coeffs[i] * val;
      if (canFail(i + 1, next)) {
        assign[i] = val;
        if (await dfs(i + 1, next)) return true;
      }
    }
    return false;
  };
  // 初始残差为表达式常量（任何赋值下都存在）；
  // 固定边与自由边都在 DFS 中恰好贡献一次。
  return (await dfs(0, target.d.constant)) ? assign.slice() : null;
}
