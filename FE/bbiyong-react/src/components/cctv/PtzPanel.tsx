import { useSim } from '../../SimContext'
import type { KeyName } from '../../types'

// CCTV 카메라 조작 패널 (WASD PTZ + 줌)
export default function PtzPanel() {
  const { status, activeKeys, actions } = useSim()
  const { ptz } = status
  // 키보드 WASD → PTZ 방향 / 버튼은 방향키 기호로 표기
  const keyDir: Record<KeyName, string> = { w: 'u', a: 'l', s: 'd', d: 'r' }
  const glyph: Record<KeyName, string> = { w: '△', a: '◁', s: '▽', d: '▷' }
  const btn = (k: KeyName, dir: string) => (
    <button
      className={activeKeys[k] ? 'active' : ''}
      aria-label={k}
      onClick={() => actions.ptzMove(dir)}
    >
      {glyph[k]}
    </button>
  )
  return (
    <div className="card">
      <h3>
        🕹 CCTV 카메라 조작 패널
        <span style={{ fontWeight: 400, color: 'var(--sub)', fontSize: 11, marginLeft: 6 }}>— CAM 3</span>
      </h3>
      <div className="ptz">
        {/* 실제 키보드 방향키(inverted-T): △ 위 / ◁ ▽ ▷ 아래 한 줄 */}
        <div className="pad">
          <span />{btn('w', keyDir.w)}<span />
          {btn('a', keyDir.a)}{btn('s', keyDir.s)}{btn('d', keyDir.d)}
        </div>
        <div className="zoom">
          <button onClick={() => actions.ptzZoom(1)}>＋</button>
          <button onClick={() => actions.ptzZoom(-1)}>－</button>
        </div>
        <div className="meta">
          팬/틸트: <b className="mono">{ptz.x}, {ptz.y}</b><br />
          줌: <b className="mono">{ptz.z.toFixed(1)}×</b><br />
          프리셋: 하역장 게이트
        </div>
      </div>
    </div>
  )
}
