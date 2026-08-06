import { useState } from 'react'
import type { InspectionCandidate, InspectionPoint } from '../../live/contracts.d.ts'

// AprilTag 점검 지점 승인 (S15P11E101-787)
//
// 로봇이 태그를 보면 후보를 올린다. auto_confirm 은 false 라 사람이 승인해야
// 순찰 목적지가 된다 — 이 화면이 그 유일한 경로다.
//
// 그래서 '누르기 전에 무엇을 승인하는지 알 수 있는가' 가 이 패널의 전부다.
// 태그 번호, 얼마나 확신하는지, 어느 좌표인지, 언제 본 것인지를 함께 둔다.

/** 이보다 낮으면 눈으로 한 번 더 보라고 말한다. 로봇이 자신 없어 하는 값이다. */
const LOW_CONFIDENCE = 0.7

const m1 = (v: number | undefined) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '—')

// '20:14' — 오늘 밤 안에 일어난 일이라 날짜까지는 필요 없다.
const timeText = (iso: string | null | undefined) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function InspectionPanel({
  candidates, points, onConfirm, onReject, onRename, onToggle, onDelete, onPublish,
  selectedId, onSelect,
}: {
  candidates: InspectionCandidate[],
  points: InspectionPoint[],
  onConfirm: (candidateId: string, name: string) => void,
  onReject: (candidateId: string) => void,
  onRename: (pointId: string, name: string) => void,
  onToggle: (pointId: string, enabled: boolean) => void,
  onDelete: (pointId: string) => void,
  onPublish: () => void,
  selectedId?: string | null,
  onSelect?: (id: string | null) => void,
}) {
  // 승인하며 붙이는 이름. 비워 두면 '태그 N' 이 된다 — 이름 때문에 승인이 막히면 안 된다.
  const [names, setNames] = useState<Record<string, string>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const nameOf = (id: string) => names[id] ?? ''
  const draftOf = (p: InspectionPoint) => drafts[p.pointId] ?? p.name

  return (
    <div className="card-v3" id="pInspection">
      <h3 style={{ margin: 0, marginBottom: '12px' }}>
        점검 지점 <span className="k">APRILTAG INSPECTION</span>
        {!!points.length && (
          <button
            type="button" className="btn-tonal" id="btnPublishPoints" onClick={onPublish}
            style={{ marginLeft: 'auto', padding: '4px 12px', fontSize: '12px' }}
          >
            로봇에 반영
          </button>
        )}
      </h3>
      <p className="cfg-help">
        로봇이 벽에서 AprilTag 를 찾으면 후보로 올립니다.
        <b> 확인을 눌러야 순찰 목적지가 됩니다</b> — 로봇이 스스로 목적지를 늘리지 않습니다.
      </p>

      {/* ── 승인 대기 ───────────────────────────────────────────── */}
      <div className="insp-head">
        <b>승인 대기</b>
        <span className="k">{candidates.length}건</span>
      </div>
      {!candidates.length
        ? <div className="cfg-note" id="inspEmpty">대기 중인 후보가 없습니다. 로봇이 태그를 보면 여기에 올라옵니다.</div>
        : (
          <ul className="insp-list" id="inspCandidates">
            {candidates.map((c) => (
              <li
                key={c.candidateId}
                className={`insp-cand${selectedId === c.candidateId ? ' picked' : ''}`}
                onMouseEnter={() => onSelect?.(c.candidateId)}
                onMouseLeave={() => onSelect?.(null)}
              >
                <div className="insp-top">
                  <b className="mono">태그 {c.tagId}</b>
                  {/* 로봇이 자신 없어 하면 그렇다고 말한다 — 숫자만 두면 아무도 안 읽는다 */}
                  <span className={`tag conf${c.confidence < LOW_CONFIDENCE ? ' low' : ''}`}>
                    확신 {Math.round(c.confidence * 100)}%
                  </span>
                  <span className="k mono">{timeText(c.createdAt)}</span>
                </div>
                <div className="insp-coord mono">
                  태그 ({m1(c.target?.x)}, {m1(c.target?.y)}) m
                  · 정차 ({m1(c.viewpoint?.x)}, {m1(c.viewpoint?.y)}) m
                  · {m1(c.standOffM)} m 앞
                </div>
                {c.confidence < LOW_CONFIDENCE && (
                  <div className="insp-warn">확신이 낮습니다 — 지도에서 자리를 확인한 뒤 승인하세요.</div>
                )}
                <div className="insp-act">
                  <input
                    className="insp-name"
                    placeholder={`태그 ${c.tagId}`}
                    value={nameOf(c.candidateId)}
                    onChange={(e) => setNames((n) => ({ ...n, [c.candidateId]: e.target.value }))}
                    aria-label={`태그 ${c.tagId} 이름`}
                  />
                  <button
                    type="button" className="btn-filled insp-ok"
                    data-candidate={c.candidateId}
                    onClick={() => onConfirm(c.candidateId, nameOf(c.candidateId).trim())}
                  >
                    확인
                  </button>
                  <button
                    type="button" className="btn-text insp-no"
                    data-candidate={c.candidateId}
                    onClick={() => onReject(c.candidateId)}
                  >
                    거절
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

      {/* ── 확정 ────────────────────────────────────────────────── */}
      <div className="insp-head">
        <b>확정 점검 지점</b>
        <span className="k">{points.length}곳</span>
      </div>
      {!points.length
        ? <div className="cfg-note">아직 확정된 점검 지점이 없습니다.</div>
        : (
          <ul className="insp-list" id="inspPoints">
            {points.map((p) => (
              <li
                key={p.pointId}
                className={`insp-point${p.enabled ? '' : ' off'}${selectedId === p.pointId ? ' picked' : ''}`}
                onMouseEnter={() => onSelect?.(p.pointId)}
                onMouseLeave={() => onSelect?.(null)}
              >
                <span className="insp-seq mono">{p.sequence}</span>
                <input
                  className="insp-name"
                  value={draftOf(p)}
                  onChange={(e) => setDrafts((d) => ({ ...d, [p.pointId]: e.target.value }))}
                  onBlur={() => {
                    const v = draftOf(p).trim()
                    if (v && v !== p.name) onRename(p.pointId, v)
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                  aria-label={`${p.name} 이름`}
                />
                <span className="insp-coord mono">
                  ({m1(p.target?.x)}, {m1(p.target?.y)}) m
                </span>
                {/* 지우지 않고 이번 순찰에서만 빼는 길. 태그는 벽에 그대로 있다. */}
                <label className="insp-en">
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    onChange={(e) => onToggle(p.pointId, e.target.checked)}
                    aria-label={`${p.name} 순찰 포함`}
                  />
                  <span>순찰</span>
                </label>
                <button
                  type="button" className="btn-text insp-del"
                  data-point={p.pointId}
                  onClick={() => onDelete(p.pointId)}
                  aria-label={`${p.name} 삭제`}
                >
                  삭제
                </button>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}
