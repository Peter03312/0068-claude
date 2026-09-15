import { useMemo, useState } from 'react';
import type { Project } from '../domain/types';
import { listEdges } from '../domain/linear';

interface GraphSvgProps {
  project: Project;
  /** 反例赋值：每条边 0/1（按边字典序）；存在时按其高亮 */
  counterexample?: number[];
  /** 是否展示一个具体赋值（反例或见证）下边的虚实 */
  witness?: number[];
  hoveredEdge: number | null;
  onHoverEdge: (index: number | null) => void;
}

const WIDTH = 460;
const HEIGHT = 380;

export function GraphSvg({ project, counterexample, witness, hoveredEdge, onHoverEdge }: GraphSvgProps) {
  const n = project.memberCount;
  const edges = useMemo(() => listEdges(n), [n]);

  // 每条边的合取后状态
  const fixOf = useMemo(() => {
    const fixed = new Map<number, 'required' | 'forbidden' | 'unknown'>();
    for (const e of edges) fixed.set(e.index, 'unknown');
    for (const c of project.constraints) {
      const lo = Math.min(c.a, c.b);
      const hi = Math.max(c.a, c.b);
      const ed = edges.find((e) => e.a === lo && e.b === hi);
      if (!ed) continue;
      if (c.status === 'unknown') continue;
      const cur = fixed.get(ed.index);
      if (cur === undefined || cur === 'unknown') {
        fixed.set(ed.index, c.status);
      } else if (cur !== c.status) {
        fixed.set(ed.index, 'forbidden'); // 冲突：无模型报告会说明，这里仅降级绘制
      }
    }
    return fixed;
  }, [edges, project.constraints]);

  // 顶点圆周布局，A 从正上方开始顺时针
  const positions = useMemo(() => {
    const cx = WIDTH / 2;
    const cy = HEIGHT / 2 + 6;
    const r = Math.min(WIDTH, HEIGHT) / 2 - 52;
    return Array.from({ length: n }, (_, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
    });
  }, [n]);

  const [hoverVertex, setHoverVertex] = useState<number | null>(null);
  const assignment = counterexample ?? witness;

  return (
    <svg
      className="graph-svg"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label="成员关系图"
      onMouseLeave={() => {
        onHoverEdge(null);
        setHoverVertex(null);
      }}
    >
      {edges.map((ed) => {
        const p1 = positions[ed.a];
        const p2 = positions[ed.b];
        const fix = fixOf.get(ed.index) ?? 'unknown';
        const val = assignment ? assignment[ed.index] : null;
        const isCounterEdge = counterexample ? counterexample[ed.index] === 1 : false;
        const isHover = hoveredEdge === ed.index;

        let cls = 'edge';
        if (counterexample) cls += isCounterEdge ? ' edge-counter' : ' edge-counter-off';
        else if (witness) cls += val === 1 ? ' edge-present' : ' edge-absent';
        else cls += fix === 'required' ? ' edge-required' : fix === 'forbidden' ? ' edge-forbidden' : ' edge-unknown';
        if (isHover) cls += ' edge-hover';

        const label = `x${letter(ed.a)}${letter(ed.b)}`;
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        return (
          <g key={ed.index} onMouseEnter={() => onHoverEdge(ed.index)}>
            {/* 更粗的透明命中区，方便悬停 */}
            <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} className="edge-hit" />
            <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} className={cls} />
            {(isHover || isCounterEdge) && (
              <text x={mx} y={my - 6} className="edge-tag" textAnchor="middle">
                {label}
                {val !== null ? ` = ${val}` : ''}
              </text>
            )}
          </g>
        );
      })}

      {positions.map((p, i) => (
        <g
          key={i}
          onMouseEnter={() => setHoverVertex(i)}
          onMouseLeave={() => setHoverVertex(null)}
          className={hoverVertex === i ? 'vertex vertex-hover' : 'vertex'}
        >
          <circle cx={p.x} cy={p.y} r={20} className={`vertex-circle group-${project.group[i]}`} />
          <text x={p.x} y={p.y + 4} className="vertex-label" textAnchor="middle">
            {letter(i)}
          </text>
          <text x={p.x} y={p.y + 36} className="vertex-name" textAnchor="middle">
            {project.members[i] ?? ''}
          </text>
        </g>
      ))}
    </svg>
  );
}

function letter(i: number): string {
  return String.fromCharCode(65 + i);
}
