// 语义层：把表达式线性化为 k + Σ c_e · x_e（x_e ∈ {0,1} 为边指示量）。
// deg(v)、within()、cross() 都是边指示量的线性组合，因此任何允许的表达式
// 都能线性化；二倍项只改变整体系数。

import type { Expr } from './expression';

export interface GraphDef {
  n: number;
  /** 每位成员所属组（0 或 1） */
  group: number[];
}

export interface Linear {
  /** 常量项 */
  constant: number;
  /** 每条边（按 edgeIndex 顺序）的系数 */
  coeffs: number[];
}

/** 全部无向边（a<b）按 (a,b) 字典序排列，与“成员序列边且 0<1”一致 */
export function listEdges(n: number): { a: number; b: number; index: number }[] {
  const edges: { a: number; b: number; index: number }[] = [];
  let index = 0;
  for (let a = 0; a < n; a += 1) {
    for (let b = a + 1; b < n; b += 1) {
      edges.push({ a, b, index });
      index += 1;
    }
  }
  return edges;
}

export function edgeIndexOf(a: number, b: number, n: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  // 在 lo 之前的行各有 n-1, n-2, ... 条边
  return lo * n - (lo * (lo + 1)) / 2 + (hi - lo - 1);
}

export function linearize(expr: Expr, def: GraphDef): Linear {
  const m = (def.n * (def.n - 1)) / 2;
  const out: Linear = { constant: 0, coeffs: new Array(m).fill(0) };

  const addInto = (target: Linear, src: Linear, sign: number): void => {
    target.constant += sign * src.constant;
    for (let i = 0; i < m; i += 1) target.coeffs[i] += sign * src.coeffs[i];
  };

  const go = (e: Expr): Linear => {
    switch (e.type) {
      case 'num':
        return { constant: e.value, coeffs: new Array(m).fill(0) };
      case 'edge': {
        const r: Linear = { constant: 0, coeffs: new Array(m).fill(0) };
        r.coeffs[edgeIndexOf(e.a, e.b, def.n)] = 1;
        return r;
      }
      case 'deg': {
        const r: Linear = { constant: 0, coeffs: new Array(m).fill(0) };
        for (let b = 0; b < def.n; b += 1) {
          if (b === e.v) continue;
          r.coeffs[edgeIndexOf(e.v, b, def.n)] = 1;
        }
        return r;
      }
      case 'within': {
        const r: Linear = { constant: 0, coeffs: new Array(m).fill(0) };
        for (const ed of listEdges(def.n)) {
          if (def.group[ed.a] === def.group[ed.b]) r.coeffs[ed.index] = 1;
        }
        return r;
      }
      case 'cross': {
        const r: Linear = { constant: 0, coeffs: new Array(m).fill(0) };
        for (const ed of listEdges(def.n)) {
          if (def.group[ed.a] !== def.group[ed.b]) r.coeffs[ed.index] = 1;
        }
        return r;
      }
      case 'add': {
        const l = go(e.left);
        const r = go(e.right);
        addInto(l, r, 1);
        return l;
      }
      case 'sub': {
        const l = go(e.left);
        const r = go(e.right);
        addInto(l, r, -1);
        return l;
      }
      case 'mul2': {
        const inner = go(e.inner);
        return { constant: 2 * inner.constant, coeffs: inner.coeffs.map((c) => 2 * c) };
      }
    }
  };

  const r = go(expr);
  addInto(out, r, 1);
  return out;
}

export function evalLinear(l: Linear, assignment: number[]): number {
  let v = l.constant;
  for (let i = 0; i < l.coeffs.length; i += 1) {
    v += l.coeffs[i] * assignment[i];
  }
  return v;
}

/** 线性式之差：a - b */
export function subLinear(a: Linear, b: Linear): Linear {
  return {
    constant: a.constant - b.constant,
    coeffs: a.coeffs.map((c, i) => c - b.coeffs[i])
  };
}
