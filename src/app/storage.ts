import type { Project } from '../domain/types';

const STORAGE_KEY = 'ribbon-parity-lab:draft:v1';

export function saveDraft(project: Project): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
  } catch {
    // 存储不可用时静默失败（隐私模式等），不影响编辑
  }
}

export function loadDraft(): Project | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Project;
    if (!isProjectShape(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** 交接 JSON 的基本形状校验（详细非法值由校验器报告） */
export function isProjectShape(value: unknown): value is Project {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    p.schemaVersion === 1 &&
    typeof p.name === 'string' &&
    typeof p.memberCount === 'number' &&
    Array.isArray(p.members) &&
    Array.isArray(p.group) &&
    Array.isArray(p.constraints) &&
    typeof p.targetLeft === 'string' &&
    typeof p.targetRight === 'string' &&
    Array.isArray(p.cards)
  );
}

export function projectToJson(project: Project): string {
  return JSON.stringify(project, null, 2);
}

export function projectFromJson(text: string): Project {
  const parsed: unknown = JSON.parse(text);
  if (!isProjectShape(parsed)) {
    throw new Error('JSON 不是可识别的项目结构（缺少必要字段或 schemaVersion 不为 1）');
  }
  return parsed;
}
