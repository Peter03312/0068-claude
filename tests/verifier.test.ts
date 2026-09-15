import { describe, it, expect } from 'vitest';
import { verifyProject } from '../src/domain/verifier';
import type { Project, ProofCard, RuleId } from '../src/domain/types';
import { emptyProject } from '../src/domain/types';

function baseProject(overrides: Partial<Project> = {}): Project {
  return {
    ...emptyProject(),
    name: '测试展签',
    memberCount: 3,
    members: ['小禾', '小桐', '小夏'],
    group: [0, 0, 1],
    constraints: [],
    cards: [],
    targetLeft: '',
    targetRight: '',
    ...overrides
  };
}

let seq = 0;
function card(kind: ProofCard['kind'], rule: RuleId, left: string, right: string, refs: string[] = []): ProofCard {
  seq += 1;
  return { id: `c${seq}`, kind, rule, left, right, refs };
}

/** 标准合法链：n=3，分组 A,B 同组，C 另一组；
 *  deg(A)+deg(B)+deg(C) = 2*xAB + 2*xAC + 2*xBC ≡ 0
 *  k1-k3 展开度数；k4 同加减；k5 引用两张展开式一次性代换；
 *  k6 等式传递；k7 按边归组（左侧原样、右侧配对成二倍项）；
 *  k8 由 X=2Y+Z 推同奇偶（Z=0）。 */
function validChain(): ProofCard[] {
  const mk = (id: string, ...args: Parameters<typeof card>): ProofCard => ({ ...card(...args), id });
  return [
    mk('k1', 'equation', 'expand', 'deg(A)', 'xAB + xAC'),
    mk('k2', 'equation', 'expand', 'deg(B)', 'xAB + xBC'),
    mk('k3', 'equation', 'expand', 'deg(C)', 'xAC + xBC'),
    mk('k4', 'equation', 'addsub', 'deg(A) + deg(B) + deg(C)', 'xAB + xAC + deg(B) + deg(C)', ['k1']),
    mk('k5', 'equation', 'substitute', 'xAB + xAC + deg(B) + deg(C)', 'xAB + xAC + xAB + xBC + xAC + xBC', ['k2', 'k3']),
    mk('k6', 'equation', 'transitive', 'deg(A) + deg(B) + deg(C)', 'xAB + xAC + xAB + xBC + xAC + xBC', ['k4', 'k5']),
    mk('k7', 'equation', 'regroup', 'deg(A) + deg(B) + deg(C)', '2*xAB + 2*xAC + 2*xBC', ['k6']),
    mk('k8', 'parity', 'parity', 'deg(A) + deg(B) + deg(C)', '0', ['k7'])
  ];
}

describe('end-to-end verification', () => {
  it('accepts the full sound chain with no constraints', async () => {
    const project = baseProject({ cards: validChain() });
    const r = await verifyProject(project);
    expect(r.unsat).toBe(false);
    expect(r.firstError).toBeNull();
    expect(r.modelCount).toBe(8);
  });

  it('rejects a shape-wrong card even though the equality is numerically true', async () => {
    // 2*within() = 2*xAB 在当前分组下恒真，但不能直接当成规则步骤
    const cards = [card('equation', 'expand', '2*within()', '2*xAB')];
    const r = await verifyProject(baseProject({ cards }));
    expect(r.firstError).not.toBeNull();
    expect(r.firstError?.kind).toBe('shape');
  });

  it('reports unsatisfiable constraints separately (no vacuous pass)', async () => {
    const project = baseProject({
      constraints: [
        { id: 'e1', a: 0, b: 1, status: 'required' },
        { id: 'e2', a: 1, b: 0, status: 'forbidden' }
      ],
      cards: validChain()
    });
    const r = await verifyProject(project);
    expect(r.unsat).toBe(true);
    expect(r.modelCount).toBeNull();
    expect(r.firstError).toBeNull(); // 不会借助真空蕴含判定卡片成立
    expect(r.unsatReason).toContain('xAB');
  });

  it('only references earlier cards', async () => {
    const c1 = card('equation', 'expand', 'deg(A)', 'xAB + xAC');
    const c2 = card('equation', 'expand', 'deg(B)', 'xAB + xBC');
    c1.refs = [c2.id]; // 前向引用
    const r = await verifyProject(baseProject({ cards: [c1, c2] }));
    expect(r.firstError?.kind).toBe('reference');
    expect(r.firstError?.cardId).toBe(c1.id);
  });

  it('parity card from 2Y+Z chain passes on all models', async () => {
    // validChain 的第 9 张就是奇偶卡（sum ≡ 0），其语义在所有图上为真（握手引理）
    const r = await verifyProject(baseProject({ cards: validChain() }));
    expect(r.firstError).toBeNull();
  });

  it('checks the free-form target parity on every model and returns a counterexample', async () => {
    // 目标 deg(A) ≡ 0 一般为假；无约束时最小反例需 deg(A) 奇：
    // 边序 xAB,xAC,xBC，最小使 xAB+xAC 奇的赋值为 [0,1,0]
    const r = await verifyProject(baseProject({ targetLeft: 'deg(A)', targetRight: '0' }));
    expect(r.firstError).toBeNull();
    expect(r.target.ok).toBe(false);
    expect(r.target.counterexample).toEqual([0, 1, 0]);
    expect(r.target.valueLeft).toBe(1);
    expect(r.target.valueRight).toBe(0);
  });

  it('target becomes true when all incident edges are required in pairs (2*cross ≡ 0 with xAC,xBC required)', async () => {
    const project = baseProject({
      constraints: [
        { id: 'e1', a: 0, b: 2, status: 'required' },
        { id: 'e2', a: 1, b: 2, status: 'required' }
      ],
      targetLeft: '2*cross()',
      targetRight: '0'
    });
    const r = await verifyProject(project);
    expect(r.unsat).toBe(false);
    expect(r.target.ok).toBe(true);
  });

  it('counterexample is lexicographically minimal and includes values and dependency chain', async () => {
    // 错误目标：deg(A) ≡ 0，且 xAB 必有 → 最小失败赋值 [1,0,0]
    const project = baseProject({
      constraints: [{ id: 'e1', a: 0, b: 1, status: 'required' }],
      targetLeft: 'deg(A)',
      targetRight: '0'
    });
    const r = await verifyProject(project);
    expect(r.target.counterexample).toEqual([1, 0, 0]);
  });
});
