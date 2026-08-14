import { useEffect, useRef } from 'react'
import { useLive } from '../../live/LiveContext.tsx'
import { HLS_LAG_FALLBACK_S } from '../../live/config.ts'
import type { DetectionsMessage } from '../../live/contracts.d.ts'

// 화재·연기 검출 박스를 영상 위에 겹쳐 그린다.
//
// 왜 별도 레이어인가
//   2026-08-12 이전에는 로봇이 박스를 **JPEG 픽셀에 직접 그려서** 보냈다. 전면 영상이
//   HLS(H.264 세그먼트)로 옮겨가면서 프레임에 메타데이터를 실을 수 없게 됐고, 그래서
//   박스가 별도 메시지(DETECTIONS)로 분리됐다. 이 컴포넌트가 그것을 받아 그린다.
//
// 🔴 왜 시각을 맞춰야 하는가 — 이 파일에서 가장 중요한 부분
//   DETECTIONS 는 WebSocket 으로 즉시 오는데 영상은 HLS 라 약 6초 늦다. 그냥 그리면
//   **불이 화면에 나타나기 6초 전에 박스가 먼저 뜬다.** 조작자는 "저기 불이 있다"고
//   읽는데 화면에는 아직 아무것도 없다 — 신뢰를 잃는 가장 빠른 길이다.
//   그래서 받은 것을 버퍼에 쌓아 두고, `captureTs` 가 "지금 화면에 보이는 시각"에
//   가장 가까운 것을 꺼내 그린다.
//
// 🔴 왜 src_w/src_h 로 나누는가
//   로봇 추론은 640x360 에서 하고 영상은 1280x720 이다. 고정 상수로 나누면 **정확히
//   2배 어긋난다**(실측 확인). 로봇이 기준 해상도를 함께 보내는 이유가 그것이다.

type Props = {
  /** 짝이 되는 <video>. 표시 영역·해상도를 여기서 읽는다. */
  videoRef: React.RefObject<HTMLVideoElement | null>
  /** hls.js 가 알려주는 실측 지연(초). 없으면 상수 폴백을 쓴다. */
  latency?: number | null
}

/** 로봇 엔진 클래스 고정값: 0=smoke, 1=fire */
const COLOR_FIRE = '#ff4d3d'
const COLOR_SMOKE = '#ffb020'
/** 이 이상 어긋나면 그리지 않는다 — 틀린 자리의 박스보다 없는 편이 낫다. */
const MAX_GAP_S = 2
/** 30초치(4Hz × 30s = 120). 넉넉히 잡아도 메시지가 작아 부담이 없다. */
const BUF_MAX = 160

export default function DetectionOverlay({ videoRef, latency }: Props) {
  const { onDetections } = useLive()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const bufRef = useRef<DetectionsMessage[]>([])
  const lagRef = useRef<number>(HLS_LAG_FALLBACK_S)

  // 지연 값이 오면 그것을 쓴다. 상수보다 정확하고, 네트워크가 나빠져 지연이 늘어도
  // 박스가 따라간다. 하한을 0 으로 둔 것은 WebRTC(~0.3s) 전환 때문이다 — 종전 HLS 는
  // 6초여서 0.5 미만을 스타트업 튐으로 걸렀지만, 이제 sub-second 가 정상값이다.
  // 상한(60초)은 그대로 터무니없는 값 방어.
  if (latency != null && latency >= 0 && latency < 60) lagRef.current = latency

  useEffect(() => {
    if (!onDetections) return undefined
    return onDetections((msg) => {
      if (!msg?.src_w || !msg?.src_h) return
      const buf = bufRef.current
      buf.push(msg)
      if (buf.length > BUF_MAX) buf.splice(0, buf.length - BUF_MAX)
    })
  }, [onDetections])

  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const video = videoRef.current
      const cv = canvasRef.current
      if (!video || !cv) return

      const r = video.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return
      // 고해상도 화면에서 선이 흐려지지 않게 DPR 을 곱한다. 2 로 자른다 —
      // 3x 화면에서 버퍼가 9배가 되면 그리기 비용이 눈에 띄게 늘어난다.
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const bw = Math.round(r.width * dpr)
      const bh = Math.round(r.height * dpr)
      if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh }
      const g = cv.getContext('2d')
      if (!g) return
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, r.width, r.height)

      const vw = video.videoWidth
      const vh = video.videoHeight
      // 재생 전(readyState<2)이거나 해상도를 아직 모르면 그릴 기준이 없다.
      if (video.readyState < 2 || !vw || !vh) return

      // 지금 화면에 보이는 것은 lag 초 전에 촬영된 프레임이다.
      const target = Date.now() / 1000 - lagRef.current
      const buf = bufRef.current
      let best: DetectionsMessage | null = null
      let bestGap = Infinity
      for (let i = buf.length - 1; i >= 0; i--) {
        const ts = buf[i].captureTs
        if (typeof ts !== 'number') continue
        const gap = Math.abs(ts - target)
        if (gap < bestGap) { bestGap = gap; best = buf[i] }
        else if (bestGap < 1) break   // 뒤에서부터 보므로 다시 벌어지면 그만 본다
      }
      if (!best || bestGap > MAX_GAP_S || !best.dets?.length) return

      // 🔴 object-fit:cover 로 잘려나간 만큼 좌표가 어긋난다. 표시 영역을 직접 계산한다.
      const scale = Math.max(r.width / vw, r.height / vh)
      const dw = vw * scale
      const dh = vh * scale
      const ox = (r.width - dw) / 2
      const oy = (r.height - dh) / 2
      // 🔴 영상 해상도가 아니라 **추론 기준 해상도**로 나눈다.
      const kx = dw / (best.src_w as number)
      const ky = dh / (best.src_h as number)

      g.lineWidth = 2
      g.font = '600 12px system-ui, sans-serif'
      g.textBaseline = 'alphabetic'
      for (const d of best.dets) {
        const b = d.box
        if (!b || b.length < 4) continue
        const x = ox + b[0] * kx
        const y = oy + b[1] * ky
        const w = (b[2] - b[0]) * kx
        const h = (b[3] - b[1]) * ky
        const color = d.cls === 1 ? COLOR_FIRE : COLOR_SMOKE
        g.strokeStyle = color
        g.strokeRect(x, y, w, h)
        const label = `${d.name ?? (d.cls === 1 ? 'fire' : 'smoke')} ${Math.round((d.conf ?? 0) * 100)}%`
        const tw = g.measureText(label).width
        const ly = Math.max(16, y)          // 프레임 위로 넘치면 안쪽에 붙인다
        g.fillStyle = color
        g.fillRect(x, ly - 16, tw + 8, 16)
        g.fillStyle = '#0b0f12'
        g.fillText(label, x + 4, ly - 4)
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [videoRef])

  return <canvas ref={canvasRef} className="det-overlay" aria-hidden="true" />
}
