import { describe, it, expect } from 'vitest';
import { fingerprint, stableStringify } from '../src/app/fingerprint';
import { projectFromJson, projectToJson, isProjectShape } from '../src/app/storage';
import { emptyProject } from '../src/domain/types';
import type { Project } from '../src/domain/types';

describe('fingerprint', () => {
  it('is stable for the same content', () => {
    const a = emptyProject();
    const b: Project = { ...a };
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('changes when an edge constraint changes', () => {
    const a = emptyProject();
    const b: Project = { ...a, constraints: [{ id: 'x', a: 0, b: 1, status: 'required' }] };
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });
});

describe('JSON handoff', () => {
  it('round-trips a project', () => {
    const p: Project = {
      ...emptyProject(),
      memberCount: 3,
      members: ['甲', '乙', '丙'],
      group: [0, 1, 0],
      constraints: [{ id: 'c1', a: 0, b: 2, status: 'forbidden' }],
      targetLeft: 'deg(A)',
      targetRight: '0',
      cards: [{ id: 'k1', kind: 'equation', left: 'deg(A)', right: 'xAB + xAC', rule: 'expand', refs: [] }]
    };
    const text = projectToJson(p);
    expect(projectFromJson(text)).toEqual(p);
  });

  it('rejects malformed JSON and wrong schema', () => {
    expect(isProjectShape(null)).toBe(false);
    expect(isProjectShape({ hello: 1 })).toBe(false);
    expect(() => projectFromJson('{not json')).toThrow();
  });
});
