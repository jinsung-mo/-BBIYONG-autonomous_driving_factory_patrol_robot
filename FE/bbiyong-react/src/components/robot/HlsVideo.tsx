import { useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import { HLS_URL } from '../../live/config.ts'

// 전면 카메라 HLS 재생.
//
// 왜 캔버스가 아니라 <video> 인가
//   2026-08-12 에 로봇이 `ORINCAR_VIDEO_TRANSPORT=off` 로 전환했다. FRONT 프레임은 더 이상
//   WebSocket 으로 오지 않고, Orin /video.mjpg → AWS ffmpeg → H.264/HLS → nginx 정적 경로로
//   나간다. 그래서 FE 가 base64 JPEG 을 받아 캔버스에 그릴 대상이 없어졌다.
//   대신 브라우저의 영상 파이프라인에 맡긴다 — 디코드가 메인스레드 밖에서 돌고, 세그먼트는
//   nginx 가 정적 파일로 뿌리므로 시청자가 늘어도 서버 팬아웃이 선형으로 늘지 않는다.
//
// 지연은 약 6초다(세그먼트 2초 × 플레이어 버퍼 3개). 수동조종은 포기했으므로(감시 전용,
// 사용자 결정 2026-08-12) 이 지연은 받아들인 값이다. LL-HLS 는 쓰지 않는다.
//
// hls.js 를 동적 import 하는 이유
//   Chrome·Firefox·Edge 는 <video src="*.m3u8"> 를 네이티브로 재생하지 못한다. Safari·iOS 는
//   된다. 그래서 네이티브가 되면 hls.js 를 아예 내려받지 않고, 안 되면 그때만 가져온다 —
//   메인 번들에 넣으면 카메라를 보지 않는 사람도 함께 내려받는다.
//
// 🔴 muted·playsInline 이 없으면 브라우저가 자동재생을 막는다. 조작자가 매번 재생 버튼을
//    눌러야 하는 화면이 되므로 둘 다 필수다.

export type HlsHealth = 'loading' | 'playing' | 'stalled' | 'error'

/** 치명 오류 후 재접속 간격. 라이브는 세그먼트가 곧 사라지므로 재시도가 정상 경로다. */
const RETRY_MS = 3000

export default function HlsVideo({ src = HLS_URL, className, style, onHealth }: {
  src?: string,
  className?: string,
  style?: CSSProperties,
  onHealth?: (health: HlsHealth) => void,
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  // onHealth 를 ref 에 담는 이유: 의존성에 넣으면 부모가 인라인 함수를 넘길 때마다 effect 가
  // 재실행돼 스트림이 끊긴다.
  const healthRef = useRef(onHealth)
  healthRef.current = onHealth

  useEffect(() => {
    const video = videoRef.current
    if (!video) return undefined

    let destroyed = false
    let hls: { destroy: () => void } | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const report = (health: HlsHealth) => { if (!destroyed) healthRef.current?.(health) }

    const onPlaying = () => report('playing')
    const onWaiting = () => report('stalled')
    video.addEventListener('playing', onPlaying)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('stalled', onWaiting)

    const scheduleRetry = () => {
      if (destroyed || retryTimer) return
      retryTimer = setTimeout(() => { retryTimer = null; if (!destroyed) attach() }, RETRY_MS)
    }

    function attach() {
      if (destroyed || !video) return
      report('loading')

      // Safari·iOS — 네이티브 재생. hls.js 를 내려받지 않는다.
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src
        video.play().catch(() => { /* 자동재생 차단은 muted 로 이미 회피했다 */ })
        return
      }

      import('hls.js').then(({ default: Hls }) => {
        if (destroyed) return
        if (!Hls.isSupported()) {
          // MSE 가 없는 환경(구형 브라우저). 네이티브도 아니면 재생할 방법이 없다.
          report('error')
          return
        }
        // liveDurationInfinity: 라이브를 유한 길이로 잡으면 진행바가 생기고 끝에서 멈춘다.
        const instance = new Hls({ liveDurationInfinity: true })
        hls = instance
        instance.on(Hls.Events.ERROR, (_evt: unknown, data: { fatal?: boolean }) => {
          if (!data?.fatal) return   // 비치명 오류는 hls.js 가 스스로 복구한다
          report('error')
          instance.destroy()
          if (hls === instance) hls = null
          scheduleRetry()            // ffmpeg 재기동·네트워크 순단 후 스스로 붙어야 한다
        })
        instance.loadSource(src)
        instance.attachMedia(video)
        video.play().catch(() => { /* 위와 같음 */ })
      }).catch(() => {
        report('error')
        scheduleRetry()              // 청크 로드 실패(배포 중 등)도 재시도로 회복한다
      })
    }

    attach()

    return () => {
      destroyed = true
      if (retryTimer) clearTimeout(retryTimer)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('stalled', onWaiting)
      hls?.destroy()
      // src 를 비워 두지 않으면 언마운트 후에도 브라우저가 세그먼트를 계속 내려받는다.
      video.removeAttribute('src')
      video.load()
    }
  }, [src])

  return (
    <video
      ref={videoRef}
      className={className}
      style={style}
      muted
      playsInline
      autoPlay
      // 조작자가 실수로 멈추면 "영상이 죽었다"로 오인한다. 감시 화면이라 조작할 것이 없다.
      controls={false}
    />
  )
}
