// 六条允许规则的“形状与前提”校验。
// 与语义校验（在所有图模型上求值）互相独立：
//   - 形状对，但命题并非在所有模型成立        → 反例错误
//   - 形状不对（哪怕等式恒真）                → 规则依据错误
// 这样能杜绝“结论碰巧对但推理不合规”的卡片。

import type { Expr } from './expression';
import { printExpr } from './expression';
import type { Linear } from './linear';
import type { GraphDef } from './linear';
import { linearize, listEdges, edgeIndexOf } from './linear';
import type { ProofCard, RuleId } from './types';
import { indexToLetter } from './expression';

export interface RuleVerdict {
  valid: boolean;
  reason: string;
}

// ---------- 结构化“扁平和”表示 ----------
// 一个表达式按顶层 +/- 展平为：
//   const：整数常量之和
//   edges[e]：边指示量 x_e 的“字面出现净值”（带符号，x_e 与 -x_e 相消）
//   doubles[e]：以二倍项字面量 2*x_e 形式的出现净值
//   atoms：其它原子（deg/within/cross）以及 2(...) 包裹的非边表达式的净值
// 注意：edges 只统计“裸露的边指示量”；2*xAB 计入 doubles。

export type AtomKey = string;
export interface Flat {
  const: number;
  edges: number[]; // 长度 m
  doubles: number[]; // 长度 m
  atoms: Map<AtomKey, number>;
}

function atomKey(e: Expr): AtomKey {
  return printExpr(e);
}

function emptyFlat(m: number): Flat {
  return { const: 0, edges: new Array(m).fill(0), doubles: new Array(m).fill(0), atoms: new Map() };
}

function bumpAtom(map: Map<AtomKey, number>, key: AtomKey, delta: number): void {
  map.set(key, (map.get(key) ?? 0) + delta);
}

export function flatten(expr: Expr, n: number): Flat {
  const m = (n * (n - 1)) / 2;
  const out = emptyFlat(m);

  const go = (e: Expr, sign: 1 | -1): void => {
    switch (e.type) {
      case 'add':
        go(e.left, sign);
        go(e.right, sign);
        return;
      case 'sub':
        go(e.left, sign);
        go(e.right, sign === 1 ? -1 : 1);
        return;
      case 'num':
        out.const += sign * e.value;
        return;
      case 'edge': {
        const idx = edgeIdx(e.a, e.b, n);
        out.edges[idx] += sign;
        return;
      }
      case 'mul2':
        if (e.inner.type === 'edge') {
          const idx = edgeIdx(e.inner.a, e.inner.b, n);
          out.doubles[idx] += sign;
        } else {
          bumpAtom(out.atoms, atomKey(e), sign);
        }
        return;
      default:
        bumpAtom(out.atoms, atomKey(e), sign);
    }
  };
  go(expr, 1);
  return out;
}

function edgeIdx(a: number, b: number, n: number): number {
  return edgeIndexOf(a, b, n);
}

/** 两个扁平表示是否完全一致（常量、裸边、二倍边、其它原子） */
function flatEqual(a: Flat, b: Flat, m: number): boolean {
  if (a.const !== b.const) return false;
  for (let i = 0; i < m; i += 1) {
    if (a.edges[i] !== b.edges[i]) return false;
    if (a.doubles[i] !== b.doubles[i]) return false;
  }
  const keys = new Set<string>([...a.atoms.keys(), ...b.atoms.keys()]);
  for (const k of keys) {
    if ((a.atoms.get(k) ?? 0) !== (b.atoms.get(k) ?? 0)) return false;
  }
  return true;
}

function linEqual(a: Linear, b: Linear): boolean {
  if (a.constant !== b.constant) return false;
  for (let i = 0; i < a.coeffs.length; i += 1) if (a.coeffs[i] !== b.coeffs[i]) return false;
  return true;
}

// ---------- 工具：在 AST 中把所有出现的 from 替换为 to ----------

function substituteAst(e: Expr, from: Expr, to: Expr): Expr {
  if (astIdentical(e, from)) return to;
  switch (e.type) {
    case 'add':
      return { type: 'add', left: substituteAst(e.left, from, to), right: substituteAst(e.right, from, to) };
    case 'sub':
      return { type: 'sub', left: substituteAst(e.left, from, to), right: substituteAst(e.right, from, to) };
    case 'mul2':
      return { type: 'mul2', inner: substituteAst(e.inner, from, to) };
    default:
      return e;
  }
}

export function astIdentical(a: Expr, b: Expr): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'num':
      return a.type === b.type && a.value === (b as { value: number }).value;
    case 'edge':
      return b.type === 'edge' && a.a === b.a && a.b === b.b;
    case 'deg':
      return b.type === 'deg' && a.v === b.v;
    case 'within':
    case 'cross':
      return true;
    case 'add':
    case 'sub':
      return (
        b.type === a.type && astIdentical(a.left, (b as { left: Expr }).left) && astIdentical(a.right, (b as { right: Expr }).right)
      );
    case 'mul2':
      return b.type === 'mul2' && astIdentical(a.inner, b.inner);
  }
}

function astContains(e: Expr, target: Expr): boolean {
  if (astIdentical(e, target)) return true;
  if (e.type === 'add' || e.type === 'sub') return astContains(e.left, target) || astContains(e.right, target);
  if (e.type === 'mul2') return astContains(e.inner, target);
  return false;
}

// ---------- 规则专用判断 ----------

/** deg(v) 展开式：deg(v) = 按成员序列排列的各条关联边之和（允许反向、允许 -0 外的朴素排列由 Flat 抵消） */
function checkExpand(curL: Expr, curR: Expr, def: GraphDef): RuleVerdict {
  const tryOne = (degSide: Expr, sumSide: Expr): RuleVerdict | null => {
    if (degSide.type !== 'deg') return null;
    const v = degSide.v;
    const f = flatten(sumSide, def.n);
    if (f.const !== 0 || f.atoms.size !== 0) {
      return { valid: false, reason: '展开度数的另一侧只能是与该成员相连的边指示量之和，不能含常量、deg、within 或 cross' };
    }
    for (let b = 0; b < def.n; b += 1) {
      if (b === v) continue;
      const idx = edgeIdx(v, b, def.n);
      if (f.edges[idx] !== 1 || f.doubles[idx] !== 0) {
        return {
          valid: false,
          reason: `按度数定义，应恰好出现一次边 x${indexToLetter(Math.min(v, b))}${indexToLetter(Math.max(v, b))}（且不能写成二倍项）`
        };
      }
    }
    // 不能含与 v 不相连的边
    for (let i = 0; i < f.edges.length; i += 1) {
      const ed = listEdges(def.n)[i];
      if (ed.a !== v && ed.b !== v && (f.edges[i] !== 0 || f.doubles[i] !== 0)) {
        return { valid: false, reason: '展开式中出现了与该成员不相连的边' };
      }
    }
    return { valid: true, reason: `度数定义：deg(${indexToLetter(v)}) 等于与 ${indexToLetter(v)} 相连的每条边指示量之和` };
  };
  const ok = tryOne(curL, curR) ?? tryOne(curR, curL);
  return ok ?? { valid: false, reason: '展开度数卡必须形如 deg(V) = xV? + xV? + …，右侧逐条列出与 V 相连的边' };
}

/** 无引用归组：within() = 组内边之和，或 cross() = 跨组边之和 */
function checkRegroupAtomic(curL: Expr, curR: Expr, def: GraphDef): RuleVerdict {
  const tryOne = (atomSide: Expr, sumSide: Expr): RuleVerdict | null => {
    const want = atomSide.type === 'within' ? 'within' : atomSide.type === 'cross' ? 'cross' : null;
    if (!want) return null;
    const f = flatten(sumSide, def.n);
    if (f.const !== 0 || f.atoms.size !== 0) {
      return { valid: false, reason: `${want}() 的展开侧只能含边指示量` };
    }
    for (const ed of listEdges(def.n)) {
      const sameGroup = def.group[ed.a] === def.group[ed.b];
      const expected = (want === 'within') === sameGroup ? 1 : 0;
      if (f.edges[ed.index] !== expected || f.doubles[ed.index] !== 0) {
        const label = `x${indexToLetter(ed.a)}${indexToLetter(ed.b)}`;
        return {
          valid: false,
          reason: `${want}() ${expected ? '应' : '不应'}包含${expected ? '' : ' '}${label}（两端${sameGroup ? '同组' : '跨组'}）`
        };
      }
    }
    return {
      valid: true,
      reason: `按边归组：${want}() 逐条等于所有${want === 'within' ? '组内' : '跨组'}边的指示量之和`
    };
  };
  const ok = tryOne(curL, curR) ?? tryOne(curR, curL);
  return ok ?? { valid: false, reason: '无引用的按边归组必须形如 within() = … 或 cross() = …，另一侧逐条列出对应边' };
}

/**
 * 有引用归组：把前提等式里“相同边的裸指示量”两两收成 2*x（每组相同边最多剩一条），
 * 常量与其它原子（deg/within/cross/2(...)）原样保留；两侧变换一致。
 */
function checkRegroupPair(curL: Expr, curR: Expr, preL: Expr, preR: Expr, def: GraphDef): RuleVerdict {
  const m = (def.n * (def.n - 1)) / 2;
  const fPreL = flatten(preL, def.n);
  const fPreR = flatten(preR, def.n);
  const fCurL = flatten(curL, def.n);
  const fCurR = flatten(curR, def.n);

  // 对一侧而言，当前式要么是前提侧原样，要么是把成对裸边配成 2*x（每条边至多剩一条）
  const sideOk = (pre: Flat, cur: Flat): boolean => {
    if (flatEqual(pre, cur, m)) return true; // 该侧原样保留
    if (pre.const !== cur.const) return false;
    const keys = new Set<string>([...pre.atoms.keys(), ...cur.atoms.keys()]);
    for (const k of keys) if ((pre.atoms.get(k) ?? 0) !== (cur.atoms.get(k) ?? 0)) return false;
    for (let i = 0; i < m; i += 1) {
      const c = pre.edges[i];
      const pairs = Math.floor(Math.abs(c) / 2);
      const rem = Math.abs(c) % 2;
      const sgn = c < 0 ? -1 : 1;
      if (cur.edges[i] !== sgn * rem) return false;
      if (cur.doubles[i] !== sgn * pairs) return false;
    }
    return true;
  };
  // 前提等式左右可整体翻转
  if (!((sideOk(fPreL, fCurL) && sideOk(fPreR, fCurR)) || (sideOk(fPreR, fCurL) && sideOk(fPreL, fCurR)))) {
    return {
      valid: false,
      reason: '按边归组只能把相同边的两个指示量合并成一个 2*x（每条边至多剩一条），其余项与常量必须原样保留'
    };
  }
  // 必须确实发生了至少一次归组，否则应当直接用传递/代换，不构成“归组”这一步
  let merged = false;
  for (let i = 0; i < m; i += 1) {
    if (fCurL.doubles[i] !== 0 || fCurR.doubles[i] !== 0) merged = true;
  }
  if (!merged) {
    return { valid: false, reason: '没有任何相同边被两两归入二倍项；这一步不构成“按边归组”' };
  }
  return { valid: true, reason: '相同边指示量两两配成 2*x，余下单边保留' };
}

/** 代换：在当前等式一侧中，把引用等式的某侧整体替换为另一侧，结果须与当前另一侧结构一致 */
function checkSubstitute(curL: Expr, curR: Expr, premises: { l: Expr; r: Expr }[], def: GraphDef): RuleVerdict {
  const m = (def.n * (def.n - 1)) / 2;
  // 允许每张引用卡选择正向或反向代换，按顺序依次作用
  const directions = premises.map(() => [0, 1] as const);
  let result: RuleVerdict | null = null;

  const attempt = (choices: number[]): boolean => {
    // 每张被引用的前提都必须在某一侧真正作为整体被代换（不允许挂名引用）
    const used = premises.map(() => false);
    const applyAll = (start: Expr): { expr: Expr; usedSide: boolean[] } => {
      let expr = start;
      const usedSide = premises.map(() => false);
      choices.forEach((dir, idx) => {
        const p = premises[idx];
        const from = dir === 0 ? p.l : p.r;
        const to = dir === 0 ? p.r : p.l;
        if (astContains(expr, from)) {
          expr = substituteAst(expr, from, to);
          usedSide[idx] = true;
          used[idx] = true;
        }
      });
      return { expr, usedSide };
    };

    // 在 curL 上代换后与 curR 一致，或在 curR 上代换后与 curL 一致
    const variants: [Expr, Expr][] = [
      [curL, curR],
      [curR, curL]
    ];
    for (const [start, target] of variants) {
      used.fill(false);
      const { expr, usedSide } = applyAll(start);
      if (usedSide.some(Boolean) && used.every(Boolean) && flatEqual(flatten(expr, def.n), flatten(target, def.n), m)) {
        return true;
      }
    }
    // 两侧同时各自代换
    used.fill(false);
    const leftRes = applyAll(curL);
    const rightRes = applyAll(curR);
    if (used.every(Boolean) && flatEqual(flatten(leftRes.expr, def.n), flatten(rightRes.expr, def.n), m)) {
      return true;
    }
    return false;
  };

  const enumerate = (i: number, choices: number[]): boolean => {
    if (i === directions.length) return attempt(choices);
    for (const d of directions[i]) {
      choices.push(d);
      if (enumerate(i + 1, choices)) return true;
      choices.pop();
    }
    return false;
  };

  if (enumerate(0, [])) {
    result = { valid: true, reason: '把引用卡等式的一侧整体代换为另一侧后，两边一致' };
  } else {
    result = {
      valid: false,
      reason: '引用等式的任何一侧都没有作为整体出现在当前式中，或代换后两边不一致；代换必须整体替换一个已证等式'
    };
  }
  return result;
}

/** 同加减：前提 L=R，当前式必须形如 (L+Q)=(R+Q)，两侧使用同一个 Q（前提可整体左右翻转） */
function checkAddSub(curL: Expr, curR: Expr, preL: Expr, preR: Expr, def: GraphDef): RuleVerdict {
  const m = (def.n * (def.n - 1)) / 2;

  const orientationWorks = (baseL: Expr, baseR: Expr): boolean => {
    const fBaseL = flatten(baseL, def.n);
    const fBaseR = flatten(baseR, def.n);
    const fCurL = flatten(curL, def.n);
    const fCurR = flatten(curR, def.n);
    const qL = diffFlat(fCurL, fBaseL);
    const qR = diffFlat(fCurR, fBaseR);
    return flatEqual(qL, qR, m) && !isZeroFlat(qL);
  };

  if (orientationWorks(preL, preR) || orientationWorks(preR, preL)) {
    return { valid: true, reason: '等式两边同时加上（或减去）同一式，等式仍成立' };
  }
  // 区分“没加减东西”与“加减得不一样”，给出更准的提示
  if (flatEqual(flatten(curL, def.n), flatten(preL, def.n), m) && flatEqual(flatten(curR, def.n), flatten(preR, def.n), m)) {
    return { valid: false, reason: '当前式与引用卡完全相同，未做同加减；原样复述请改用等式传递' };
  }
  return { valid: false, reason: '等式两边必须加上（或减去）完全相同的一式，且该式不能为空' };
}

function diffFlat(a: Flat, b: Flat): Flat {
  const q: Flat = {
    const: a.const - b.const,
    edges: a.edges.map((v, i) => v - b.edges[i]),
    doubles: a.doubles.map((v, i) => v - b.doubles[i]),
    atoms: new Map()
  };
  const keys = new Set<string>([...a.atoms.keys(), ...b.atoms.keys()]);
  for (const k of keys) q.atoms.set(k, (a.atoms.get(k) ?? 0) - (b.atoms.get(k) ?? 0));
  return q;
}

function isZeroFlat(f: Flat): boolean {
  return (
    f.const === 0 &&
    f.edges.every((v) => v === 0) &&
    f.doubles.every((v) => v === 0) &&
    [...f.atoms.values()].every((v) => v === 0)
  );
}

/** 传递：引用两张等式卡 A=B、B=C，当前为 A=C（端点可互换） */
function checkTransitive(
  curL: Expr,
  curR: Expr,
  p1: { l: Expr; r: Expr },
  p2: { l: Expr; r: Expr },
  def: GraphDef
): RuleVerdict {
  const m = (def.n * (def.n - 1)) / 2;
  const fCurL = flatten(curL, def.n);
  const fCurR = flatten(curR, def.n);
  // 四条连接方式：(l1-r1)(l2-r2)，共享端须一致
  const ends1: [Flat, Flat][] = [
    [flatten(p1.l, def.n), flatten(p1.r, def.n)],
    [flatten(p1.r, def.n), flatten(p1.l, def.n)]
  ];
  const ends2: [Flat, Flat][] = [
    [flatten(p2.l, def.n), flatten(p2.r, def.n)],
    [flatten(p2.r, def.n), flatten(p2.l, def.n)]
  ];
  for (const [a, b] of ends1) {
    for (const [b2, c] of ends2) {
      if (flatEqual(b, b2, m)) {
        if (
          (flatEqual(fCurL, a, m) && flatEqual(fCurR, c, m)) ||
          (flatEqual(fCurL, c, m) && flatEqual(fCurR, a, m))
        ) {
          return { valid: true, reason: '等式传递：两张引用卡的中间端相同，首尾相等' };
        }
      }
    }
  }
  return { valid: false, reason: '传递需要两张引用卡形如 A=B 与 B=C（中间端必须完全相同），当前卡为 A=C' };
}

/** 奇偶：引用等式必须为 X = 2Y + Z（加法可交换，允许 Z=0，
 *  也允许右端有多个二倍项，其中任意一部分留在 Z 中——它们本身仍是偶数）。
 *  当前奇偶卡为 X ≡ Z。 */
function containsMul2(e: Expr): boolean {
  if (e.type === 'mul2') return true;
  if (e.type === 'add' || e.type === 'sub') return containsMul2(e.left) || containsMul2(e.right);
  return false;
}

function checkParity(curL: Expr, curR: Expr, preL: Expr, preR: Expr, def: GraphDef): RuleVerdict {
  const m = (def.n * (def.n - 1)) / 2;
  const fCurL = flatten(curL, def.n);
  const fCurR = flatten(curR, def.n);

  const orientation = (xSide: Expr, other: Expr): RuleVerdict | null => {
    // 结构：other 顶层必须至少含一个二倍项（mul2）；写成 X = 2Y + Z 时，
    // 非二倍部分必须整体进 Z，多个二倍项可在 2Y 与 Z 间分配（留 Z 的仍是偶数），
    // 允许 Z = 0。当前奇偶卡必须为 X ≡ Z。
    if (!containsMul2(other)) return null;

    const fX = flatten(xSide, def.n);

    // 收集 other 顶层各 mul2 项的扁平贡献，以及所有非二倍部分 baseOther
    const pieces: Flat[] = [];
    const baseOther = emptyFlat(m);
    const walk = (e: Expr, sign: 1 | -1): void => {
      if (e.type === 'add') {
        walk(e.left, sign);
        walk(e.right, sign);
        return;
      }
      if (e.type === 'sub') {
        walk(e.left, sign);
        walk(e.right, sign === 1 ? -1 : 1);
        return;
      }
      if (e.type === 'mul2') {
        const f = emptyFlat(m);
        if (e.inner.type === 'edge') {
          f.doubles[edgeIdx(e.inner.a, e.inner.b, def.n)] = 1;
        } else {
          bumpAtom(f.atoms, atomKey(e), 1);
        }
        pieces.push(scaleFlat(f, sign));
        return;
      }
      const one = emptyFlat(m);
      addFlat(one, e, sign, def.n);
      mergeInto(baseOther, one);
    };
    walk(other, 1);
    if (pieces.length === 0) return null;

    // 枚举非空二倍项子集进 2Y，其余留 Z
    for (let mask = 1; mask < 1 << pieces.length; mask += 1) {
      const z = cloneFlat(baseOther);
      for (let i = 0; i < pieces.length; i += 1) {
        if (!(mask & (1 << i))) mergeInto(z, pieces[i]);
      }
      if (
        (flatEqual(fX, fCurL, m) && flatEqual(z, fCurR, m)) ||
        (flatEqual(fX, fCurR, m) && flatEqual(z, fCurL, m))
      ) {
        return { valid: true, reason: '前提写成 X = 2Y + Z；2Y 为偶数，故 X 与 Z 同奇偶' };
      }
    }
    return null;
  };

  const ok = orientation(preL, preR) ?? orientation(preR, preL);
  return ok ?? { valid: false, reason: '奇偶规则的引用等式必须形如 X = 2Y + Z（至少一个二倍项加另一式，允许 Z=0），当前卡为 X ≡ Z' };
}

function scaleFlat(f: Flat, sign: 1 | -1): Flat {
  if (sign === 1) return f;
  return {
    const: -f.const,
    edges: f.edges.map((v) => -v),
    doubles: f.doubles.map((v) => -v),
    atoms: new Map([...f.atoms].map(([k, v]) => [k, -v]))
  };
}

function cloneFlat(f: Flat): Flat {
  return {
    const: f.const,
    edges: f.edges.slice(),
    doubles: f.doubles.slice(),
    atoms: new Map(f.atoms)
  };
}

function mergeInto(acc: Flat, f: Flat): void {
  acc.const += f.const;
  for (let i = 0; i < acc.edges.length; i += 1) {
    acc.edges[i] += f.edges[i];
    acc.doubles[i] += f.doubles[i];
  }
  for (const [k, v] of f.atoms) bumpAtom(acc.atoms, k, v);
}

/** 把任意非 mul2 表达式按符号并入一个 Flat（供奇偶分解使用） */
function addFlat(target: Flat, e: Expr, sign: 1 | -1, n: number): void {
  const one = flatten(e, n);
  mergeInto(target, scaleFlat(one, sign));
  // flatten 已含整个表达式（内部的 mul2 会落进 doubles/atoms），这里不做额外处理
}


// ---------- 入口 ----------

export interface PremiseCard {
  card: ProofCard;
  l: Expr;
  r: Expr;
}

export interface RuleCheckInput {
  card: ProofCard;
  curL: Expr;
  curR: Expr;
  premises: PremiseCard[];
  def: GraphDef;
}

/** 引用数量/类型的前置要求 */
function checkRefArity(card: ProofCard): RuleVerdict {
  const k = card.refs.length;
  const need: Record<RuleId, string> = {
    expand: '展开度数不引用前卡',
    regroup: '归组：0 张引用（within/cross 展开）或 1 张引用（配对成二倍项）',
    substitute: '代换至少引用 1 张等式卡',
    addsub: '同加减恰好引用 1 张等式卡',
    transitive: '等式传递恰好引用 2 张等式卡',
    parity: '奇偶规则恰好引用 1 张等式卡'
  };
  switch (card.rule) {
    case 'expand':
      return k === 0 ? { valid: true, reason: need.expand } : { valid: false, reason: need.expand };
    case 'regroup':
      return k === 0 || k === 1 ? { valid: true, reason: '' } : { valid: false, reason: need.regroup };
    case 'substitute':
      return k >= 1 ? { valid: true, reason: '' } : { valid: false, reason: need.substitute };
    case 'addsub':
    case 'parity':
      return k === 1 ? { valid: true, reason: '' } : { valid: false, reason: need[card.rule] };
    case 'transitive':
      return k === 2 ? { valid: true, reason: '' } : { valid: false, reason: need.transitive };
  }
}

export function checkRuleShape(input: RuleCheckInput): RuleVerdict {
  const { card, curL, curR, premises, def } = input;

  if (card.kind === 'parity' && card.rule !== 'parity') {
    return { valid: false, reason: '奇偶式卡片只能使用“由 X=2Y+Z 推同奇偶”规则' };
  }
  if (card.kind === 'equation' && card.rule === 'parity') {
    return { valid: false, reason: '奇偶规则只能用在奇偶式（≡）卡片上' };
  }
  for (const p of premises) {
    if (card.rule !== 'parity' && p.card.kind !== 'equation') {
      return { valid: false, reason: '等式推理只能引用等式卡；奇偶卡不能作为等式前提' };
    }
  }

  const arity = checkRefArity(card);
  if (!arity.valid) return arity;

  switch (card.rule) {
    case 'expand':
      return checkExpand(curL, curR, def);
    case 'regroup':
      if (premises.length === 0) return checkRegroupAtomic(curL, curR, def);
      return checkRegroupPair(curL, curR, premises[0].l, premises[0].r, def);
    case 'substitute':
      return checkSubstitute(
        curL,
        curR,
        premises.map((p) => ({ l: p.l, r: p.r })),
        def
      );
    case 'addsub': {
      const v = checkAddSub(curL, curR, premises[0].l, premises[0].r, def);
      if (!v.valid) return v;
      // 线性一致性兜底（形状校验已基本保证）
      const same =
        linEqual(linearize(curL, def), linearize(curR, def)) ===
        linEqual(linearize(premises[0].l, def), linearize(premises[0].r, def));
      return same
        ? v
        : { valid: false, reason: '同加减后与引用等式不再是同一种相等关系' };
    }
    case 'transitive':
      return checkTransitive(curL, curR, { l: premises[0].l, r: premises[0].r }, { l: premises[1].l, r: premises[1].r }, def);
    case 'parity':
      return checkParity(curL, curR, premises[0].l, premises[0].r, def);
  }
}
