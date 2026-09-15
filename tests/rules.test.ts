import { describe, it, expect } from 'vitest';
import { parseExpression } from '../src/domain/expression';
import { checkRuleShape } from '../src/domain/rules';
import type { PremiseCard } from '../src/domain/rules';
import type { GraphDef } from '../src/domain/linear';
import type { ProofCard, RuleId } from '../src/domain/types';

const def: GraphDef = { n: 3, group: [0, 0, 1] };

function parse(text: string) {
  const r = parseExpression(text);
  if (!r.ok) throw new Error(r.message);
  return r.expr;
}

interface Built {
  card: ProofCard;
  l: ReturnType<typeof parse>;
  r: ReturnType<typeof parse>;
}

let counter = 0;
function makeCard(rule: RuleId, l: string, r: string, refs: ProofCard[] = [], kind: ProofCard['kind'] = 'equation'): Built {
  counter += 1;
  return {
    card: { id: `t${counter}`, kind, left: l, right: r, rule, refs: refs.map((x) => x.id) },
    l: parse(l),
    r: parse(r)
  };
}

function run(rule: RuleId, l: string, r: string, premises: Built[] = [], kind: ProofCard['kind'] = 'equation') {
  const cur = makeCard(rule, l, r, [], kind);
  cur.card.refs = premises.map((p) => p.card.id);
  return checkRuleShape({
    card: cur.card,
    curL: cur.l,
    curR: cur.r,
    premises: premises.map((p): PremiseCard => ({ card: p.card, l: p.l, r: p.r })),
    def
  });
}

describe('expand degree rule shape', () => {
  it('accepts exact incident-edge sum (either direction)', () => {
    expect(run('expand', 'deg(A)', 'xAB + xAC').valid).toBe(true);
    expect(run('expand', 'xAC + xBC', 'deg(C)').valid).toBe(true);
  });
  it('rejects missing edge or an extra non-incident edge', () => {
    expect(run('expand', 'deg(A)', 'xAB').valid).toBe(false);
    expect(run('expand', 'deg(A)', 'xAB + xBC').valid).toBe(false);
  });
  it('rejects when the sum is written with a doubled term', () => {
    expect(run('expand', 'deg(A)', '2*xAB').valid).toBe(false);
  });
  it('does not take premises', () => {
    const pre = makeCard('expand', 'deg(B)', 'xAB + xBC');
    expect(run('expand', 'deg(A)', 'xAB + xAC', [pre]).valid).toBe(false);
  });
});

describe('regroup rule shapes', () => {
  it('expands within() to within-group edges', () => {
    expect(run('regroup', 'within()', 'xAB').valid).toBe(true);
  });
  it('expands cross() to cross-group edges', () => {
    expect(run('regroup', 'cross()', 'xAC + xBC').valid).toBe(true);
  });
  it('rejects wrong grouping even though cardinalities match', () => {
    expect(run('regroup', 'within()', 'xAC').valid).toBe(false);
    expect(run('regroup', 'cross()', 'xAB + xAC').valid).toBe(false);
  });
  it('pairs identical bare edges into 2*x with at most one leftover', () => {
    const pre = makeCard('expand', 'deg(A) + deg(B) + deg(C)', 'xAB + xAC + xAB + xBC + xAC + xBC');
    expect(run('regroup', 'deg(A) + deg(B) + deg(C)', '2*xAB + 2*xAC + 2*xBC', [pre]).valid).toBe(true);
  });
  it('rejects pairing that leaves two bare copies or touches other atoms', () => {
    const pre = makeCard('expand', 'deg(A) + deg(B) + deg(C)', 'xAB + xAC + xAB + xBC + xAC + xBC');
    expect(run('regroup', 'deg(A) + deg(B) + deg(C)', 'xAB + xAB + 2*xAC + 2*xBC', [pre]).valid).toBe(false);
  });
  it('rejects a regroup step that changes nothing', () => {
    const pre = makeCard('expand', 'deg(A)', 'xAB + xAC');
    expect(run('regroup', 'deg(A)', 'xAB + xAC', [pre]).valid).toBe(false);
  });
});

describe('substitute / addsub / transitive', () => {
  it('substitutes a premise side as a whole', () => {
    const pre = makeCard('expand', 'deg(B)', 'xAB + xBC');
    expect(run('substitute', 'deg(A) + deg(B)', 'deg(A) + xAB + xBC', [pre]).valid).toBe(true);
  });
  it('rejects substitution when the premise side does not occur', () => {
    const pre = makeCard('expand', 'deg(B)', 'xAB + xBC');
    expect(run('substitute', 'deg(A) + deg(C)', 'deg(A) + xAB', [pre]).valid).toBe(false);
  });
  it('addsub requires the same Q on both sides', () => {
    const pre = makeCard('expand', 'deg(A)', 'xAB + xAC');
    expect(run('addsub', 'deg(A) + deg(B)', 'xAB + xAC + deg(B)', [pre]).valid).toBe(true);
    expect(run('addsub', 'deg(A) + deg(B)', 'xAB + xAC + deg(C)', [pre]).valid).toBe(false);
  });
  it('addsub rejects adding nothing', () => {
    const pre = makeCard('expand', 'deg(A)', 'xAB + xAC');
    expect(run('addsub', 'deg(A)', 'xAB + xAC', [pre]).valid).toBe(false);
  });
  it('transitive needs A=B and B=C to give A=C', () => {
    const p1 = makeCard('expand', 'deg(A)', 'xAB + xAC');
    const p2 = makeCard('regroup', 'xAB + xAC', 'xAC + xAB');
    expect(run('transitive', 'deg(A)', 'xAC + xBC', [p1, p2]).valid).toBe(false);
    expect(run('transitive', 'deg(A)', 'xAC + xAB', [p1, p2]).valid).toBe(true);
  });
  it('substitute rejects a named-but-unused premise', () => {
    // 引用了两张卡，但只有第一张真正被用到
    const pre = makeCard('expand', 'deg(B)', 'xAB + xBC');
    const extra = makeCard('expand', 'deg(C)', 'xAC + xBC');
    expect(run('substitute', 'deg(A) + deg(B)', 'deg(A) + xAB + xBC', [pre, extra]).valid).toBe(false);
  });
});

describe('parity rule shape', () => {
  it('accepts X = 2Y + Z to conclude X ≡ Z', () => {
    const pre = makeCard('regroup', 'deg(A) + deg(B) + deg(C)', '2*xAB + 2*xAC + 2*xBC');
    // 可从三个二倍项中任取作 2Y，其余（偶数）留在 Z
    expect(run('parity', 'deg(A) + deg(B) + deg(C)', '2*xAB + 2*xAC', [pre], 'parity').valid).toBe(true);
  });
  it('accepts Z = 0 when the whole right side is a sum of doubled terms', () => {
    const pre = makeCard('regroup', 'deg(A) + deg(B) + deg(C)', '2*xAB + 2*xAC + 2*xBC');
    expect(run('parity', 'deg(A) + deg(B) + deg(C)', '0', [pre], 'parity').valid).toBe(true);
  });
  it('rejects when premise is not X = 2Y + Z', () => {
    const pre = makeCard('expand', 'deg(A)', 'xAB + xAC');
    const cur = makeCard('parity', 'deg(A)', 'xAB', [], 'parity');
    const v = checkRuleShape({
      card: cur.card,
      curL: cur.l,
      curR: cur.r,
      premises: [{ card: pre.card, l: pre.l, r: pre.r }],
      def
    });
    expect(v.valid).toBe(false);
  });
  it('parity rule cannot be attached to an equation card', () => {
    const pre = makeCard('regroup', 'within()', '2*xAB + xAC');
    // 当前卡是等式种类却选了奇偶规则：即便其它形状类似也必须拒绝
    expect(run('parity', 'within()', 'xAC', [pre], 'equation').valid).toBe(false);
  });
});
