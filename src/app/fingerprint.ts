// 稳定指纹：同一份项目内容 ⇒ 同一指纹；用于 worker 结果与当前编辑状态对齐。
// 采用 FNV-1a（32 位）处理规范化 JSON，足够区分编辑版本，不依赖 crypto 同步可用性。

import type { Project } from '../domain/types';

export function stableStringify(project: Project): string {
  return JSON.stringify(project, (_key, value) => {
    // 项目结构简单（数组/字符串/数字）；保持键序稳定即可
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
}

export function fingerprint(project: Project): string {
  const s = stableStringify(project);
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
