import { useEffect, useMemo, useRef, useState } from 'react';
import type { EdgeConstraint, EdgeStatus, ProofCard, Project, RuleId } from './domain/types';
import { emptyProject, uid, MIN_MEMBERS, MAX_MEMBERS } from './domain/types';
import { listEdges } from './domain/linear';
import { useVerification } from './app/useVerification';
import { describeCardBases, RULE_LABELS, STATUS_LABELS } from './app/basis';
import { saveDraft, loadDraft, clearDraft, projectToJson, projectFromJson } from './app/storage';
import { GraphSvg } from './components/GraphSvg';

const letter = (i: number): string => String.fromCharCode(65 + i);
const edgeName = (a: number, b: number): string => `x${letter(Math.min(a, b))}${letter(Math.max(a, b))}`;

export default function App() {
  const [project, setProject] = useState<Project>(() => loadDraft() ?? emptyProject());
  const [savedTick, setSavedTick] = useState(0);
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const errorCardRef = useRef<HTMLDivElement | null>(null);

  const verification = useVerification(project);
  const { report, status } = verification;

  // 自动保存草稿（本地恢复）
  useEffect(() => {
    saveDraft(project);
  }, [project, savedTick]);

  // 首张错误卡滚动定位
  useEffect(() => {
    if (report?.firstError && status === 'done') {
      const el = document.getElementById(`card-${report.firstError.cardId}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [report, status]);

  const bases = useMemo(() => describeCardBases(project), [project]);
  const edges = useMemo(() => listEdges(project.memberCount), [project.memberCount]);

  const firstError = report?.firstError ?? null;
  const ce = firstError?.counterexample ?? report?.target.counterexample ?? undefined;
  const witness = !report?.unsat ? report?.witness : undefined;

  // ---------- 编辑动作 ----------

  const update = (patch: Partial<Project>): void => setProject((p) => ({ ...p, ...patch }));

  const changeMemberCount = (next: number): void => {
    const n = Math.max(MIN_MEMBERS, Math.min(MAX_MEMBERS, Math.round(next)));
    setProject((p) => {
      const members = Array.from({ length: n }, (_, i) => p.members[i] ?? `成员 ${letter(i)}`);
      const group = Array.from({ length: n }, (_, i) => p.group[i] ?? 0);
      const constraints = p.constraints.filter((c) => c.a < n && c.b < n);
      return { ...p, memberCount: n, members, group, constraints };
    });
  };

  const setMemberName = (i: number, name: string): void => {
    setProject((p) => {
      const members = p.members.slice();
      members[i] = name;
      return { ...p, members };
    });
  };
  const toggleGroup = (i: number): void => {
    setProject((p) => {
      const group = p.group.slice();
      group[i] = group[i] === 0 ? 1 : 0;
      return { ...p, group };
    });
  };

  const addConstraint = (): void => {
    if (project.memberCount < 2) return;
    const c: EdgeConstraint = { id: uid('c'), a: 0, b: 1 % project.memberCount, status: 'required' };
    update({ constraints: [...project.constraints, c] });
  };
  const updateConstraint = (id: string, patch: Partial<EdgeConstraint>): void => {
    update({ constraints: project.constraints.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  };
  const removeConstraint = (id: string): void => {
    update({ constraints: project.constraints.filter((c) => c.id !== id) });
  };

  const addCard = (kind: ProofCard['kind']): void => {
    const card: ProofCard = {
      id: uid('k'),
      kind,
      left: '',
      right: '',
      rule: kind === 'parity' ? 'parity' : 'expand',
      refs: []
    };
    update({ cards: [...project.cards, card] });
  };
  const updateCard = (id: string, patch: Partial<ProofCard>): void => {
    update({ cards: project.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  };
  const removeCard = (id: string): void => {
    update({
      cards: project.cards.filter((c) => c.id !== id).map((c) => ({ ...c, refs: c.refs.filter((r) => r !== id) }))
    });
  };
  const moveCard = (id: string, dir: -1 | 1): void => {
    const idx = project.cards.findIndex((c) => c.id === id);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= project.cards.length) return;
    const cards = project.cards.slice();
    [cards[idx], cards[j]] = [cards[j], cards[idx]];
    // 移动后若引用越过了被引用卡，清掉非法前向引用
    const idToPos = new Map(cards.map((c, i) => [c.id, i]));
    for (const c of cards) {
      const pos = idToPos.get(c.id)!;
      c.refs = c.refs.filter((r) => (idToPos.get(r) ?? -1) < pos);
    }
    update({ cards });
  };
  const toggleRef = (cardId: string, refId: string): void => {
    const card = project.cards.find((c) => c.id === cardId);
    if (!card) return;
    const refs = card.refs.includes(refId) ? card.refs.filter((r) => r !== refId) : [...card.refs, refId];
    updateCard(cardId, { refs });
  };

  const resetAll = (): void => {
    if (!window.confirm('确定清空全部内容并恢复空白项目吗？本地草稿也会清除。')) return;
    clearDraft();
    setProject(emptyProject());
    setSavedTick((t) => t + 1);
  };

  const exportJson = (): void => {
    setJsonText(projectToJson(project));
    setJsonError(null);
    setJsonOpen(true);
  };
  const importJson = (): void => {
    try {
      const parsed = projectFromJson(jsonText);
      setProject(parsed);
      setJsonOpen(false);
      setSavedTick((t) => t + 1);
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : 'JSON 无法识别');
    }
  };
  const copyJson = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(jsonText);
    } catch {
      // 剪贴板不可用时不阻断
    }
  };

  // ---------- 渲染 ----------

  return (
    <div>
      <header className="app-header">
        <h1>友谊缎带 · 跨组奇偶证明展签工作台</h1>
        <p>
          录入 2–8 名成员与必有 / 必无 / 待定边，按序搭建结构化证明卡；每一步都会在<strong>全部满足约束的图模型</strong>上核对，
          第一张错误卡会给出字典序最小反例。
        </p>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="small" onClick={exportJson}>导出 / 交接 JSON</button>
          <button className="small" onClick={() => { setJsonText(''); setJsonError(null); setJsonOpen(true); }}>导入 JSON</button>
          <button className="small danger" onClick={resetAll}>清空重开</button>
        </div>
      </header>

      <main className="layout">
        {/* 左栏：录入 */}
        <div>
          <section className="panel">
            <h2>① 成员与分组（子集 S）</h2>
            <label className="field">
              <span>展签名称</span>
              <input type="text" value={project.name} onChange={(e) => update({ name: e.target.value })} />
            </label>
            <label className="field">
              <span>成员数（{MIN_MEMBERS}–{MAX_MEMBERS}）</span>
              <input
                type="number"
                aria-label="成员数（2–8）"
                min={MIN_MEMBERS}
                max={MAX_MEMBERS}
                value={project.memberCount}
                onChange={(e) => changeMemberCount(Number(e.target.value))}
              />
            </label>
            <p className="help">蓝点为组 0（S 外），橙点为组 1（S 内）；点击分组按钮可切换。成员固定按 A、B、C… 序列编号。</p>
            {project.members.map((name, i) => (
              <div className="member-row" key={i}>
                <span className="member-letter">{letter(i)}</span>
                <input type="text" value={name} onChange={(e) => setMemberName(i, e.target.value)} aria-label={`成员 ${letter(i)} 名称`} />
                <button
                  type="button"
                  className={`group-toggle g${project.group[i]}`}
                  onClick={() => toggleGroup(i)}
                  title="切换是否属于子集 S"
                >
                  {project.group[i] === 0 ? '组 0' : '组 1（S）'}
                </button>
                <span />
              </div>
            ))}
          </section>

          <section className="panel">
            <div className="row spread">
              <h2>② 边约束（同边可重复，取合取）</h2>
              <button className="small primary" onClick={addConstraint}>加一条</button>
            </div>
            <p className="help">
              “必有”= 这条缎带一定系上（边 = 1）；“必无”= 一定不系（边 = 0）；“待定”= 两种都要检查。
              同一条边若既必有又必无，将单独报告无模型，不会用空模型集蒙混通过。
            </p>
            {project.constraints.length === 0 && <p className="help">还没有约束——所有边都待定，共 {edges.length} 条。</p>}
            {project.constraints.map((c) => {
              return (
                <div className="constraint-row" key={c.id}>
                  <select value={c.a} onChange={(e) => updateConstraint(c.id, { a: Number(e.target.value) })} aria-label="端点一">
                    {project.members.map((_, i) => (
                      <option key={i} value={i}>{letter(i)}</option>
                    ))}
                  </select>
                  <select value={c.b} onChange={(e) => updateConstraint(c.id, { b: Number(e.target.value) })} aria-label="端点二">
                    {project.members.map((_, i) => (
                      <option key={i} value={i}>{letter(i)}</option>
                    ))}
                  </select>
                  <select
                    value={c.status}
                    onChange={(e) => updateConstraint(c.id, { status: e.target.value as EdgeStatus })}
                    aria-label="约束类型"
                  >
                    <option value="required">必有</option>
                    <option value="forbidden">必无</option>
                    <option value="unknown">待定</option>
                  </select>
                  <button className="small danger" onClick={() => removeConstraint(c.id)}>删</button>
                  {c.a === c.b && <span className="card-error-text" style={{ gridColumn: '1 / -1' }}>两个端点不能相同。</span>}
                </div>
              );
            })}
          </section>

          <section className="panel">
            <h2>③ 目标奇偶式（想在展览上讲清的结论）</h2>
            <div className="target-box">
              <div className="expr-grid">
                <input type="text" value={project.targetLeft} onChange={(e) => update({ targetLeft: e.target.value })} placeholder="如 2*cross()" />
                <span className="op">≡</span>
                <input type="text" value={project.targetRight} onChange={(e) => update({ targetRight: e.target.value })} placeholder="如 0" />
              </div>
              <p className="help" style={{ marginTop: 8 }}>
                允许：边指示量 <span className="kbd">xAB</span>、<span className="kbd">deg(A)</span>、<span className="kbd">within()</span>（组内边数）、
                <span className="kbd"> cross()</span>（跨组边数）、整数、+ / - 与一层二倍项 <span className="kbd">2Y</span>。
              </p>
            </div>
          </section>
        </div>

        {/* 中栏：证明卡 */}
        <div>
          <section className="panel">
            <div className="row spread">
              <h2>④ 结构化证明卡（只能引用排在前面的卡）</h2>
              <span className="row tight">
                <button className="small primary" onClick={() => addCard('equation')}>＋等式卡</button>
                <button className="small" onClick={() => addCard('parity')}>＋奇偶卡</button>
              </span>
            </div>
            {project.cards.length === 0 && (
              <p className="help">还没有卡片。可用规则：展开度数、按边归组、引用已证等式代换、等式两边同加减、等式传递、由 X=2Y+Z 推同奇偶。</p>
            )}
            {project.cards.map((card, i) => {
              const isBad = firstError?.cardId === card.id;
              const basis = bases.get(card.id);
              return (
                <div id={`card-${card.id}`} key={card.id} className={`card-item ${isBad ? 'bad' : ''}`} ref={isBad ? errorCardRef : undefined}>
                  <div className="card-head">
                    <span className="card-no">第 {i + 1} 张 · {card.kind === 'parity' ? '奇偶式（≡）' : '等式（=）'}</span>
                    <span className="row tight">
                      <button className="small" onClick={() => moveCard(card.id, -1)} disabled={i === 0}>↑</button>
                      <button className="small" onClick={() => moveCard(card.id, 1)} disabled={i === project.cards.length - 1}>↓</button>
                      <button className="small danger" onClick={() => removeCard(card.id)}>删除</button>
                    </span>
                  </div>
                  <div className="expr-grid">
                    <input type="text" value={card.left} onChange={(e) => updateCard(card.id, { left: e.target.value })} placeholder="左侧" aria-label={`第 ${i + 1} 张左侧`} />
                    <span className="op">{card.kind === 'parity' ? '≡' : '='}</span>
                    <input type="text" value={card.right} onChange={(e) => updateCard(card.id, { right: e.target.value })} placeholder="右侧" aria-label={`第 ${i + 1} 张右侧`} />
                  </div>
                  <label className="field" style={{ marginTop: 8 }}>
                    <span>使用的规则</span>
                    <select value={card.rule} onChange={(e) => updateCard(card.id, { rule: e.target.value as RuleId })}>
                      {card.kind === 'parity' ? (
                        <option value="parity">{RULE_LABELS.parity}</option>
                      ) : (
                        (['expand', 'regroup', 'substitute', 'addsub', 'transitive'] as RuleId[]).map((r) => (
                          <option key={r} value={r}>{RULE_LABELS[r]}</option>
                        ))
                      )}
                    </select>
                  </label>
                  {i > 0 && (
                    <div>
                      <span className="help">引用前卡：</span>
                      <div className="ref-list">
                        {project.cards.slice(0, i).map((pre, j) => (
                          <label key={pre.id}>
                            <input
                              type="checkbox"
                              checked={card.refs.includes(pre.id)}
                              onChange={() => toggleRef(card.id, pre.id)}
                            />
                            第 {j + 1} 张
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                  {basis && (
                    <p className="help" style={{ marginBottom: 0, color: basis.ok ? 'var(--good)' : 'var(--muted)' }}>
                      规则依据{basis.ok ? '✓' : '？'}：{basis.reason}
                    </p>
                  )}
                  {isBad && (
                    <div className="card-error-text">
                      {firstError?.kind === 'counterexample' ? '✗ 反例：' : '✗ '}
                      {firstError?.message}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        </div>

        {/* 右栏：结论 + 图 */}
        <div>
          <section className="panel">
            <h2>⑤ 校验结论</h2>
            <StatusPanel report={report} status={status} />
          </section>

          <section className="panel graph-wrap">
            <h2>关系图（边按成员序列，0&lt;1）</h2>
            <GraphSvg project={project} counterexample={ce} witness={ce ? undefined : witness} hoveredEdge={hoveredEdge} onHoverEdge={setHoveredEdge} />
            <div className="legend">
              <span><i />存在 / 必有</span>
              <span><i className="dashed" />不存在 / 必无</span>
              <span>橙蓝两色 = 两个组</span>
            </div>
            <EdgeTable
              project={project}
              edges={edges}
              assignment={ce ?? witness}
              isCounter={!!ce}
              hoveredEdge={hoveredEdge}
              onHover={setHoveredEdge}
            />
          </section>
        </div>
      </main>

      {jsonOpen && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setJsonOpen(false); }}>
          <div className="modal" role="dialog" aria-label="JSON 交接">
            <h3>项目 JSON 交接</h3>
            <p className="help">可复制带走、换台电脑粘贴回来；内容只在本机与你粘贴的位置流动。</p>
            <textarea value={jsonText} onChange={(e) => setJsonText(e.target.value)} style={{ minHeight: 260, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12 }} />
            {jsonError && <p className="card-error-text">{jsonError}</p>}
            <div className="row" style={{ marginTop: 10 }}>
              <button className="primary" onClick={importJson}>导入并替换当前项目</button>
              <button onClick={copyJson}>复制</button>
              <button onClick={() => setJsonOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      <p className="footer-note">草稿自动保存在本浏览器（localStorage）；穷举、剪枝与最小反例重建在 Web Worker 中完成。</p>
    </div>
  );
}

// ---------- 状态面板 ----------

function StatusPanel({ report, status }: { report: ReturnType<typeof useVerification>['report']; status: ReturnType<typeof useVerification>['status'] }) {
  if (status === 'checking' || !report) {
    return <div className="verdict info"><span className="pulse" />正在全部允许的图模型上核对…</div>;
  }
  if (report.unsat) {
    return (
      <div className="verdict unsat">
        <div className="big">⚠ 约束无模型（单独报告）</div>
        <div>{report.unsatReason}</div>
        <div className="help" style={{ color: 'inherit' }}>没有任何图同时满足这些必有/必无约束，因此不会对任何卡片下“成立”结论（禁止真空蕴含）。</div>
      </div>
    );
  }
  const modelText = report.modelCount !== null
    ? `共在 ${report.modelCount.toLocaleString()} 个满足约束的图模型上核对`
    : '';
  const ce = report.firstError?.counterexample;
  return (
    <div>
      <div className="help">{modelText}（边按成员序列、0 先于 1 的字典序搜索）。</div>
      {report.firstError ? (
        <div className="verdict err">
          <div className="big">第 {report.checkedCards + 1} 张卡未通过：{report.firstError.kind === 'shape' ? '规则依据不成立' : report.firstError.kind === 'counterexample' ? '存在反例' : '录入问题'}</div>
          <div>{report.firstError.message}</div>
          {ce && (
            <div style={{ marginTop: 6 }}>
              <div>字典序最小反例的两侧取值：左 = <strong>{report.firstError.valueLeft}</strong>，右 = <strong>{report.firstError.valueRight}</strong></div>
              {report.firstError.dependencyChain && report.firstError.dependencyChain.length > 0 && (
                <div>
                  <div className="help" style={{ color: 'inherit', marginTop: 6 }}>依赖链（该反例下每一步的取值，用于向同学讲清哪一步开始出问题）：</div>
                  <ol className="chain">
                    {report.firstError.dependencyChain.map((d) => (
                      <li key={d.cardId}>
                        第 {d.ordinal} 张（{RULE_LABELS[d.rule]}）：{d.left} {d.kind === 'parity' ? '≡' : '='} {d.right}
                        <span className="help" style={{ marginLeft: 6 }}>
                          此反例下左 {d.valueLeft} / 右 {d.valueRight}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="verdict ok">
          <div className="big">✓ {report.totalCards} 张卡的规则依据与全部模型核对都通过</div>
        </div>
      )}
      <TargetStatus report={report} />
    </div>
  );
}

function TargetStatus({ report }: { report: NonNullable<ReturnType<typeof useVerification>['report']> }) {
  const t = report.target;
  if (!t.present) return <p className="help" style={{ marginTop: 8 }}>未设置目标奇偶式。</p>;
  if (t.ok) {
    return (
      <div className="verdict ok" style={{ marginTop: 10 }}>
        <div className="big">✓ 目标奇偶式在全部 {report.modelCount?.toLocaleString()} 个模型上同奇偶</div>
      </div>
    );
  }
  return (
    <div className="verdict err" style={{ marginTop: 10 }}>
      <div className="big">目标奇偶式未达成</div>
      <div>{t.message}</div>
      {t.counterexample && (
        <div style={{ marginTop: 4 }}>
          最小反例下：左 = <strong>{t.valueLeft}</strong>，右 = <strong>{t.valueRight}</strong>（一奇一偶）。
        </div>
      )}
    </div>
  );
}

// ---------- 边列表（与 SVG 联动） ----------

function EdgeTable({
  project,
  edges,
  assignment,
  isCounter,
  hoveredEdge,
  onHover
}: {
  project: Project;
  edges: ReturnType<typeof listEdges>;
  assignment?: number[];
  isCounter: boolean;
  hoveredEdge: number | null;
  onHover: (i: number | null) => void;
}) {
  const fixOf = useMemo(() => {
    const m = new Map<number, EdgeStatus>();
    for (const c of project.constraints) {
      const lo = Math.min(c.a, c.b);
      const hi = Math.max(c.a, c.b);
      const ed = edges.find((e) => e.a === lo && e.b === hi);
      if (!ed || c.status === 'unknown') continue;
      const cur = m.get(ed.index);
      if (!cur) m.set(ed.index, c.status);
      else if (cur !== c.status) m.set(ed.index, 'forbidden');
    }
    return m;
  }, [project.constraints, edges]);

  return (
    <details style={{ marginTop: 10 }}>
      <summary className="help" style={{ cursor: 'pointer' }}>边字典序明细（悬停与图联动）</summary>
      <table className="ce-table">
        <thead>
          <tr><th>#</th><th>边</th><th>约束</th>{isCounter ? <th>反例取值</th> : <th>见证取值</th>}</tr>
        </thead>
        <tbody>
          {edges.map((ed) => {
            const fix = fixOf.get(ed.index);
            const val = assignment ? assignment[ed.index] : null;
            return (
              <tr
                key={ed.index}
                className={hoveredEdge === ed.index ? 'row-hover' : ''}
                onMouseEnter={() => onHover(ed.index)}
                onMouseLeave={() => onHover(null)}
              >
                <td>{ed.index}</td>
                <td className="kbd">{edgeName(ed.a, ed.b)}</td>
                <td>{fix ? <span className={`badge ${fix === 'required' ? 'req' : fix === 'forbidden' ? 'fbd' : 'unk'}`}>{STATUS_LABELS[fix]}</span> : <span className="badge unk">待定</span>}</td>
                <td>{val !== null ? <strong>{val}</strong> : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}
