import { describe, it, expect } from 'vitest';
import { parseExpression, printExpr } from '../src/domain/expression';
import { linearize, listEdges, edgeIndexOf } from '../src/domain/linear';
import type { GraphDef } from '../src/domain/linear';

const def3: GraphDef = { n: 3, group: [0, 0, 1] };

function lin(text: string, def: GraphDef = def3) {
  const r = parseExpression(text);
  if (!r.ok) throw new Error(`parse failed: ${r.message}`);
  return linearize(r.expr, def);
}

describe('parser', () => {
  it('parses edges, deg, within, cross, numbers', () => {
    expect(parseExpression('xAB').ok).toBe(true);
    expect(parseExpression('deg(A)').ok).toBe(true);
    expect(parseExpression('within()').ok).toBe(true);
    expect(parseExpression('cross()').ok).toBe(true);
    expect(parseExpression('42').ok).toBe(true);
  });

  it('rejects unknown identifiers and self loops', () => {
    expect(parseExpression('foo(A)').ok).toBe(false);
    expect(parseExpression('xAA').ok).toBe(false);
  });

  it('allows one layer of 2Y but not two', () => {
    expect(parseExpression('2*xAB').ok).toBe(true);
    expect(parseExpression('2(xAB + xAC)').ok).toBe(true);
    expect(parseExpression('2*2*xAB').ok).toBe(false);
    expect(parseExpression('2(2*xAB)').ok).toBe(false);
  });

  it('prints a form that round-trips', () => {
    const text = 'xAB + deg(C) - 2*cross() + 1';
    const r = parseExpression(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(parseExpression(printExpr(r.expr)).ok).toBe(true);
  });
});

describe('linearization', () => {
  it('edges ordered lexicographically with 0<1 convention', () => {
    const edges = listEdges(3).map((e) => `${e.a}${e.b}`);
    expect(edges).toEqual(['01', '02', '12']);
    expect(edgeIndexOf(1, 0, 3)).toBe(0);
    expect(edgeIndexOf(2, 0, 3)).toBe(1);
    expect(edgeIndexOf(2, 1, 3)).toBe(2);
  });

  it('deg(v) sums incident edge indicators', () => {
    const l = lin('deg(B)');
    // xAB=0, xAC=1, xBC=2
    expect(l.coeffs).toEqual([1, 0, 1]);
  });

  it('within and cross follow the subset S partition', () => {
    // groups: A0 B0 C1 → within edges {AB}, cross edges {AC, BC}
    expect(lin('within()').coeffs).toEqual([1, 0, 0]);
    expect(lin('cross()').coeffs).toEqual([0, 1, 1]);
  });

  it('2Y doubles all coefficients and the constant', () => {
    const l = lin('2*(xAB + 3)');
    expect(l.constant).toBe(6);
    expect(l.coeffs).toEqual([2, 0, 0]);
  });

  it('n=8 has 28 edges', () => {
    expect(listEdges(8)).toHaveLength(28);
  });
});
