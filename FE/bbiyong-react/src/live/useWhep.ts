// 관제 실시간 로봇 영상 — WebRTC(WHEP) 수신 훅.
//
// 2026-08-13: 전면 카메라를 HLS(5~6초 지연) 대신 WebRTC 로 받는다.
//   오린이 H.264 를 SRT 로 mediamtx 에 올리고, 브라우저는 WHEP 로 저지연(~0.3s) 수신한다.
//   시그널링: POST {REST_BASE}/webrtc/{path}/whep (HTTPS 443, nginx 프록시)
//   미디어  : UDP 8189 (서버가 공인 IP 를 ICE 후보로 광고 → STUN/TURN 불필요)
//
// active(=live 모드)일 때만 연결하고, 끊기면 자동 재시도한다.
import { useEffect, useRef, useState } from 'react'
import { REST_BASE, WHEP_PATH } from './config.ts'

const RETRY_MS = 3000
const ICE_WAIT_MS = 2000

function waitIceGathering(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check)
        resolve()
      }
    }
    pc.addEventListener('icegatheringstatechange', check)
    // 수집이 오래 걸리면(후보 일부만 있어도) 그냥 진행한다 — 공인 host 후보면 충분.
    setTimeout(resolve, ICE_WAIT_MS)
  })
}

export function useWhep(active: boolean) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    if (!active) {
      setPlaying(false)
      return undefined
    }
    let stopped = false
    let pc: RTCPeerConnection | null = null
    let retry: ReturnType<typeof setTimeout> | null = null

    const scheduleRetry = () => {
      if (stopped) return
      if (retry) clearTimeout(retry)
      retry = setTimeout(() => {
        try { pc?.close() } catch { /* 이미 닫힘 */ }
        connect()
      }, RETRY_MS)
    }

    const connect = async () => {
      if (stopped) return
      pc = new RTCPeerConnection()
      pc.addTransceiver('video', { direction: 'recvonly' })
      pc.ontrack = (e) => {
        if (videoRef.current) videoRef.current.srcObject = e.streams[0]
      }
      pc.onconnectionstatechange = () => {
        const st = pc?.connectionState
        if (st === 'connected') setPlaying(true)
        else if (st === 'failed' || st === 'disconnected' || st === 'closed') {
          setPlaying(false)
          scheduleRetry()
        }
      }

      try {
        await pc.setLocalDescription(await pc.createOffer())
        await waitIceGathering(pc)
        const resp = await fetch(`${REST_BASE}/webrtc/${WHEP_PATH}/whep`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body: pc.localDescription?.sdp ?? '',
        })
        if (!resp.ok) throw new Error(`WHEP ${resp.status}`)
        const answer = await resp.text()
        if (!stopped) {
          await pc.setRemoteDescription({ type: 'answer', sdp: answer })
        }
      } catch (err) {
        if (!stopped) {
          console.warn('[whep] 연결 실패 — 재시도', err)
          scheduleRetry()
        }
      }
    }

    connect()

    return () => {
      stopped = true
      if (retry) clearTimeout(retry)
      try { pc?.close() } catch { /* 이미 닫힘 */ }
      setPlaying(false)
    }
  }, [active])

  return { videoRef, playing }
}
