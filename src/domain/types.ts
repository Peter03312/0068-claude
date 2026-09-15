// 核心领域类型定义：成员、边约束、证明卡、项目草稿

/** 同一条边的约束记录（可重复录入；同边约束为合取） */
export type EdgeStatus = 'required' | 'forbidden' | 'unknown';
export interface EdgeConstraint {
  id: string;
  a: number; // 成员序号，0-based
  b: number; // 成员序号，0-based
  status: EdgeStatus;
}

export type RuleId =
  | 'expand' // 展开度数：deg(v) = 与 v 相连的边指示量之和
  | 'regroup' // 按边归组：组内/跨组边数按边展开；或将相同边两两归入二倍项
  | 'substitute' // 引用已证等式代换
  | 'addsub' // 等式两边同加/同减同一式
  | 'transitive' // 等式传递
  | 'parity'; // 由 X = 2Y + Z 推出 X 与 Z 同奇偶

export type CardKind = 'equation' | 'parity';

export interface ProofCard {
  id: string;
  kind: CardKind;
  left: string; // 左侧表达式文本
  right: string; // 右侧表达式文本
  rule: RuleId;
  /** 引用的前卡 id（按录入顺序；必须只引用更早的卡） */
  refs: string[];
  note?: string;
}

export interface Project {
  schemaVersion: 1;
  name: string;
  /** 成员数 2..8 */
  memberCount: number;
  /** 成员显示名（长度 = memberCount） */
  members: string[];
  /** 子集 S：在组 0/1 中的成员下标；未列入的视为不在 S（用于组内/跨组统计） */
  group: number[]; // 每位成员为 0 或 1；长度 = memberCount
  constraints: EdgeConstraint[];
  targetLeft: string;
  targetRight: string;
  cards: ProofCard[];
}

/** 边按成员序列编号：(a,b), a<b，先按 a 再按 b */
export interface Edge {
  index: number;
  a: number;
  b: number;
}

export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 8;

export function emptyProject(): Project {
  return {
    schemaVersion: 1,
    name: '友谊缎带跨组奇偶',
    memberCount: 2,
    members: ['小禾', '小桐'],
    group: [0, 1],
    constraints: [],
    targetLeft: '',
    targetRight: '',
    cards: []
  };
}

let idCounter = 0;
export function uid(prefix = 'id'): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}
