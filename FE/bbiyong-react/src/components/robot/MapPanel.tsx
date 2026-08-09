import { useCallback, useEffect, useState, lazy, Suspense } from 'react'
import { useSim } from '../../SimContext.ts'
import { useLive } from '../../live/LiveContext.tsx'
import { capOf, isDown, CAP_KEYS } from '../../live/capabilities.ts'
import { ROBOT_ID } from '../../live/config.ts'
import { displayName } from '../../live/robotName.ts'
import { isFloorplan } from '../../live/floorplan.ts'
import ErrorBoundary from '../ErrorBoundary.tsx'
import MappingProgress from './MappingProgress.tsx'
import LiveNavMap from './LiveNavMap.tsx'
// 3D 지도는 three.js 뷰다(S15P11E101-712). CSS 압출판(IsoMapView)은 지우지 않고 남겨 뒀다 —
// 되돌리려면 아래 lazy import 를 `import IsoMapView from './IsoMapView.tsx'` 로 바꾸고,
// showIso 분기의 <ThreeMapView …/> 를 <IsoMapView …/> 로 되돌리면 된다(두 줄).
//
// 🔴 정적 import 가 아니라 lazy 다. three.js 가 번들에 그대로 들어가면 초기 JS 가
// 358 → 881 kB 로 뛴다(+523 kB). 그런데 이 뷰는 **'입체' 토글을 켠 관리자만** 본다 —
// 2D 로만 쓰는 사용자에게까지 three 를 내려보낼 이유가 없다.
// 별도 청크로 쪼개면 토글을 누르는 순간에만 받는다.
import { useInspection } from '../../live/inspection.ts'

const ThreeMapView = lazy(() => import('./ThreeMapView.tsx'))

const ZOOM_MIN = 0.7
const ZOOM_MAX = 2.2
const ZOOM_STEP = 0.2
const clampZoom = (value: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(value.toFixed(2))))

// 지도 탭 (S15P11E101-744).
//
// 매핑 진행 상태에 따라 보여 줄 것이 완전히 달라진다.
//   매핑 중        : 아직 도면이 없다 — 진행 안내를 띄운다
//   도면 있음      : 3D 압출 도면(S15P11E101-676)
//   도면 없음·IDLE : 무엇을 해야 하는지 알려 준다
//
// 실시간 SLAM 점유격자는 운영 탭 전용이다. 매핑이 도는 동안 여기에 격자를 흘리면
// '지금 보고 있는 것이 확정된 지도' 라고 오해하게 된다 — 그 지도는 아직 그리는 중이다.
export default function MapPanel() {
  const { refs } = useSim()
  const { enabled, telemetry, plan, mapping, mappingStarting } = useLive()
  const mapDown = enabled && isDown(capOf(telemetry, CAP_KEYS.map))
  // 확정 점검 지점(S15P11E101-787). 운영 탭에서 승인한 AprilTag 지점을 이 지도에도 얹는다 —
  // /topic/inspection 을 그대로 구독하므로 운영 탭 2D 지도와 같은 값을 본다.
  const { points: inspectionPoints } = useInspection()

  // 정제 도면이 있으면 입체로 보여 준다(S15P11E101-676). 없으면 볼 것이 없으므로 2D 다.
  //
  // 2D 를 없애지 않고 한 번의 클릭 거리에 둔다 — 입체는 구역이 한눈에 들어오지만
  // 정확한 위치를 읽는 데는 위에서 내려다보는 편이 낫다. 조작자가 고를 일이다.
  const canIso = enabled && isFloorplan(plan)
  // 매핑 중에는 도면을 내주지 않는다. 직전 도면이 남아 있어도 지금 구조와 다를 수 있다.
  // 시작 대기(mappingStarting)도 포함 — 시작을 누른 순간부터 바로 로딩 화면을 띄운다(S15P11E101).
  const showMapping = enabled && (mapping || mappingStarting)
  // 매핑도 아니고 도면도 없으면 그릴 것이 없다 — 빈 검은 판 대신 할 일을 적어 준다.
  const showEmpty = enabled && !mapping && !mappingStarting && !plan
  // 뷰 모드 세그먼트 [2D | 3D | 네비게이션](S15P11E101-908). 예전의 입체/평면 토글 + 3D
  // 안의 네비게이션(추종) 버튼을 한 세그먼트로 합쳤다. 네비게이션은 3D 로봇 추종 시점이다.
  //   2d  → LiveNavMap(평면)
  //   3d  → ThreeMapView 개요
  //   nav → ThreeMapView 로봇 추종(follow)
  const [viewMode, setViewMode] = useState<'2d' | '3d' | 'nav'>('3d')
  const [zoom, setZoom] = useState(1)
  const [fullscreen, setFullscreen] = useState(false)
  // 도면이 사라지면(원본만 남으면) 2D 로 돌아간다 — 빈 입체 화면을 남기지 않는다. 생기면 3D 기본.
  useEffect(() => { setViewMode(canIso ? '3d' : '2d') }, [canIso])
  const showIso = canIso && viewMode !== '2d'

  useEffect(() => {
    const syncFullscreen = () => {
      const active = document.fullscreenElement === document.documentElement
      setFullscreen(active)
      document.documentElement.classList.toggle('view-fullscreen', active)
    }
    // 마운트 시점에 한 번 맞춘다(S15P11E101-809).
    // 이 표시는 상단 KPI 와 좌측 패널을 display:none 으로 접는다. 그래서 표시가
    // 남아 있으면 '상단바와 KPI 가 사라진' 것으로 보이고, 새로고침해야 돌아온다.
    //
    // 예전에는 fullscreenchange 가 올 때만 맞췄고, 정리는 언마운트 cleanup 에 맡겼다.
    // 그런데 이 앱은 탭을 옮겨도 페이지를 언마운트하지 않는다 — 모든 페이지가 계속
    // 살아 있고 CSS 로만 감춘다. 그래서 cleanup 은 사실상 실행되지 않는다.
    // 어떤 이유로든(요청 거부, 다른 요소로의 전환, 브라우저 자체 전체화면) 이벤트가
    // 한 번 어긋나면 표시가 영영 남는다.
    //
    // 그래서 '이벤트가 오면 맞춘다' 가 아니라 '실제 상태와 늘 같게 둔다' 로 바꾼다.
    syncFullscreen()
    document.addEventListener('fullscreenchange', syncFullscreen)
    // 다른 창을 보다 돌아오는 순간에도 다시 맞춘다. 전체화면 해제가 이 문서 밖에서
    // 일어나면 fullscreenchange 가 오지 않을 수 있다.
    document.addEventListener('visibilitychange', syncFullscreen)
    window.addEventListener('focus', syncFullscreen)
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreen)
      document.removeEventListener('visibilitychange', syncFullscreen)
      window.removeEventListener('focus', syncFullscreen)
      document.documentElement.classList.remove('view-fullscreen')
    }
  }, [])

  const changeZoom = useCallback((delta: number) => {
    setZoom((current) => clampZoom(current + delta))
  }, [])
  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement === document.documentElement) await document.exitFullscreen()
      else if (!document.fullscreenElement) await document.documentElement.requestFullscreen()
    } catch { /* 브라우저가 전체화면을 막으면 현재 화면을 유지한다 */ }
  }, [])

  return (
    <div className="panel" id="pMap">
      <div className={`vwrap${mapDown ? ' down' : ''}`} style={{ background: '#0a0c10' }}>
        {/* 🔴 지도 그림만 따로 감싼다(S15P11E101-897). 이 자리는 WebGL 이라 컨텍스트
            손실·드라이버 문제로 죽을 여지가 가장 크고, 실제로 한 번 화면 전체를 지웠다
            (S15P11E101-896: ThreeMapView 의 TypeError → 관제 화면 백지).
            여기서 막으면 잃는 것은 그림 한 장뿐이다 — 좌측 상태 패널도, 확대·전체화면
            버튼도, 다른 탭도 그대로 산다. '다시 시도' 는 캔버스를 새로 마운트하므로
            죽은 WebGL 컨텍스트도 같이 버려진다.
            `.vwrap` 이 `position:relative` 라 대체 UI 는 기본값(겹쳐 채우기)으로 둔다. */}
        <ErrorBoundary what="지도" hint="다시 시도를 누르면 지도만 새로 그립니다. 나머지 화면은 그대로 쓸 수 있습니다.">
        {enabled && showMapping ? <MappingProgress />
          : enabled && showEmpty ? (
            <div className="map-empty" role="status">
              <b>아직 활성 도면이 없습니다</b>
              <span>지도 탭의 '매핑'에서 맵 모델링을 시작하면 도면이 만들어집니다.</span>
            </div>
          )
          : enabled
          ? (showIso
              /* 청크를 받는 동안의 문구는 IsoMapView 계열의 `.nodata` 문법을 따른다 —
                 스피너를 쓰지 않는 것이 이 시스템의 규칙이다(로딩은 골격을 유지한 채 문구로). */
              ? (
                <Suspense fallback={<span className="nodata">입체 지도를 불러오는 중…</span>}>
                  {/* 네비게이션 모드면 로봇을 추종한다(follow) — 세그먼트가 결정(S15P11E101-908). */}
                  <ThreeMapView zoomFactor={zoom} points={inspectionPoints} follow={viewMode === 'nav'} />
                </Suspense>
              )
              /* 2D 평면 뷰. 나침반은 끈다 [사용자 지침 2026-08-09] — 정제 도면이 축 정렬이라
                 정보가 없다. 2D 에서는 로봇을 늘 중심에 두므로 follow 를 켠다(별도 추종 버튼 없음). */
              : <LiveNavMap zoomFactor={zoom} planOnly follow inspection={{ points: inspectionPoints }} lightFloor compass={false} />)
          : <canvas
              ref={refs.map2d}
              className="map-zoom-canvas"
              style={{ transform: `scale(${zoom})` }}
            />}
        </ErrorBoundary>
        {/* 뷰 세그먼트 [2D | 3D | 네비게이션](S15P11E101-908) — 좌상단, 지도/매핑 서브탭과 같은 pill 문법. */}
        {canIso && !showMapping && (
          <div className="mapview-seg" role="tablist" aria-label="지도 보기 방식">
            <button type="button" role="tab" aria-selected={viewMode === '2d'} className={viewMode === '2d' ? 'on' : ''} onClick={() => setViewMode('2d')}>2D</button>
            <button type="button" role="tab" aria-selected={viewMode === '3d'} className={viewMode === '3d' ? 'on' : ''} onClick={() => setViewMode('3d')}>3D</button>
            <button type="button" role="tab" aria-selected={viewMode === 'nav'} className={viewMode === 'nav' ? 'on' : ''} onClick={() => setViewMode('nav')}>네비게이션</button>
          </div>
        )}
        {mapDown && !showMapping && <span className="nodata">SLAM 맵 데이터 없음</span>}
        {/* 범례는 실제 도면에 보이는 것만 남긴다(S15P11E101 콘솔 정리) — 벽·로봇.
            로봇 라벨은 표시명이다(S15P11E101-879) — '오린카'는 계약 id 계열의 옛 호칭. */}
        {!showMapping && !showEmpty && <div className="maplegend" aria-label="지도 범례">
          <span><i className="legend-mark robot" />{displayName(ROBOT_ID)}</span>
          <span><i className="legend-mark wall" />벽</span>
        </div>}
        <div className="map-controls" aria-label="지도 화면 조절">
          <button
            type="button"
            className="map-control zoom-in"
            onClick={() => changeZoom(ZOOM_STEP)}
            disabled={zoom >= ZOOM_MAX}
            aria-label="지도 확대"
            title="지도 확대"
          >+</button>
          <button
            type="button"
            className="map-control zoom-out"
            onClick={() => changeZoom(-ZOOM_STEP)}
            disabled={zoom <= ZOOM_MIN}
            aria-label="지도 축소"
            title="지도 축소"
          >−</button>
          <button
            type="button"
            className="map-control fullscreen"
            onClick={toggleFullscreen}
            aria-label={fullscreen ? '전체화면 종료' : '지도 전체화면'}
            aria-pressed={fullscreen}
            title={fullscreen ? '전체화면 종료 (Esc)' : '지도 전체화면'}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {fullscreen
                ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
                : <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />}
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
