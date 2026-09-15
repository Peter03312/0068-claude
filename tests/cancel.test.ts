import { describe, it, expect } from 'vitest';
import { buildFixes, findMinCounterexample, VerificationAborted } from '../src/domain/models';

describe('cooperative cancellation', () => {
  it('throws VerificationAborted when the token is already cancelled', async () => {
    const n = 8;
    const built = buildFixes(n, []);
    if ('conflict' in built) throw new Error('unexpected conflict');
    const m = (n * (n - 1)) / 2;
    // 构造一个根剪枝无法立即排除、需要持续下探的奇偶目标
    const coeffs = new Array(m).fill(2);
    coeffs[m - 1] = 1;
    const d = { constant: 0, coeffs };
    const token = { cancelled: true };
    await expect(
      findMinCounterexample(n, built.fixes, { d, kind: 'parity' }, token)
    ).rejects.toBeInstanceOf(VerificationAborted);
  });

  it('completes normally and returns null for an identically-zero target without cancellation', async () => {
    const built = buildFixes(3, []);
    if ('conflict' in built) throw new Error('conflict');
    const ce = await findMinCounterexample(3, built.fixes, {
      d: { constant: 0, coeffs: [0, 0, 0] },
      kind: 'equation'
    });
    expect(ce).toBeNull();
  });
});
