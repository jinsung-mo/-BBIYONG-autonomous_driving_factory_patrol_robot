// LiveContext(STOMP) → Simulation(캔버스) 연결 다리.
//
// 렌더링은 아무것도 하지 않는다. live 모드일 때 실서버에서 받은
// 로봇 위치와 카메라 프레임을 기존 캔버스 렌더러에 밀어 넣어,
// 2D 지도·전면 카메라·열화상이 시뮬 대신 실제 데이터를 그리게 한다.

import { useEffect, useRef } from 'react'
import { useSim } from '../SimContext.ts'
import { useLive } from './LiveContext.tsx'
import { worldToCell } from './config.ts'
import { DRIVE_VECTORS } from './mappers.ts'
import { H264VideoDecoder } from './h264Video.ts'

// 로봇 teleop_node 의 deadman 타임아웃은 0.4초다 — 마지막 명령의 ts 가 그보다 오래되면
// 안전 정지한다(연속 스트림을 기대하는 설계). 그래서 키를 누르고 있는 동안 같은 방향을
// 10Hz 로 계속 재전송한다. 0.4초 대비 4배 여유라 한두 프레임이 밀려도 끊기지 않는다.
//
// heartbeat 는 조종 소스(브라우저)가 책임진다. 포커스·연결·전원이 끊기면 재전송이 멎고
// deadman 이 그대로 동작해 로봇이 선다 — 로봇이나 브리지가 ts 를 자체 갱신하면 안 된다.
const DRIVE_REPEAT_MS = 100

export default function LiveSimBridge(): null {
  const { actions } = useSim()
  const { enabled, connected, telemetry, onVideoFrame, control, driveMode } = useLive()

  // 채널별 최신 프레임 / 디코드 진행 여부 / 화면에 올라간 ImageBitmap
  // `${ch}_maxTemp` 키도 함께 담으므로 인덱스 시그니처가 필요하다
  const imgs = useRef<Record<string, any>>({ FRONT: null, THERMAL: null })
  const pending = useRef<Record<string, any>>({})   // 디코드 대기 중인 **최신 한 장**
  const busy = useRef<Record<string, boolean>>({})  // 디코드 진행 중 여부
  const bitmaps = useRef<Record<string, any>>({})   // 직전 ImageBitmap (close 대상)

  // ---- 위치 ----
  useEffect(() => {
    if (!enabled) { actions.setExternalPose(null); return }
    const loc = telemetry?.location
    if (!loc || typeof loc.x !== 'number' || typeof loc.y !== 'number') return
    const { c, r } = worldToCell(loc.x, loc.y)
    actions.setExternalPose({ c, r, hd: typeof loc.yaw === 'number' ? loc.yaw : undefined })
  }, [enabled, telemetry, actions])

  // ---- 카메라 프레임 ----
  useEffect(() => {
    if (!enabled) { actions.clearExternalFrames(); return undefined }

    const decoder = new H264VideoDecoder((canvas) => {
      actions.setExternalFrame('FRONT', canvas, undefined)
    })

    // 🔴 [S15P11E101] 30fps 1080p 에서 프레임이 사라지던 원인과 처방.
    //
    // 종전 코드는 채널당 Image 하나를 재사용하며 `img.src = data:image/jpeg;base64,...`
    // 를 매 프레임 재대입했다. HTML 명세상 **src 를 다시 넣으면 진행 중이던 로드가
    // 취소되고 onload 는 영영 안 불린다.** 한 장 처리(93KB base64 파싱 + JPEG 디코드)가
    // 프레임 간격 33ms 를 넘는 순간 모든 프레임이 다음 프레임에 의해 취소돼,
    // 네트워크로는 29.4fps 가 멀쩡히 도착하는데 화면은 몇 fps 만 갱신된다.
    // 취소된 작업도 CPU 는 이미 썼으므로 느려질수록 더 느려지는 악순환이다.
    //
    // 처방은 두 가지다:
    //   ① createImageBitmap — 디코드가 메인스레드를 막지 않는다. data URL 을 안 거치므로
    //      93KB base64 문자열 파싱도 사라진다(atob 는 네이티브라 훨씬 싸다).
    //   ② in-flight 가드 — 디코드 중이면 새 프레임을 시작하지 않고 **최신 한 장만**
    //      들고 있다가 끝나면 그걸 처리한다.
    // 핵심은 드랍이 없어지는 게 아니라 **드랍이 통제되는 것**이다. 종전에는 브라우저가
    // 무작위로 취소해 어느 프레임이 살아남을지 알 수 없었지만, 이제는 항상 가장 최신
    // 프레임을 그리고 중간 것만 버린다 — 라이브 관제 화면에서 원하는 동작이 정확히 이것이다.
    const hasBitmap = typeof createImageBitmap === 'function'

    const b64ToBlob = (b64: string, mime: string) => {
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return new Blob([bytes], { type: mime })
    }

    const pump = (channel: string) => {
      if (busy.current[channel]) return
      const next = pending.current[channel]
      if (!next) return
      pending.current[channel] = null
      busy.current[channel] = true
      createImageBitmap(next.blob).then((bmp: any) => {
        // 직전 비트맵은 명시적으로 닫는다 — ImageBitmap 은 GC 를 기다리면 GPU 메모리가 샌다.
        // close 와 setExternalFrame 이 같은 동기 블록이라 rAF 가 끼어들어 닫힌 걸 그릴 수 없다.
        const prev = bitmaps.current[channel]
        if (prev && typeof prev.close === 'function') prev.close()
        bitmaps.current[channel] = bmp
        actions.setExternalFrame(channel, bmp, next.maxTemp)
      }).catch(() => {
        /* 손상 프레임 한 장은 버리고 다음 장으로 간다 — 스트림을 끊지 않는다 */
      }).finally(() => {
        busy.current[channel] = false
        pump(channel)   // 대기 중 최신 프레임이 있으면 이어서
      })
    }

    const off = onVideoFrame((channel: any, frame: any) => {
      if (frame instanceof Uint8Array) {
        decoder.push(frame)
        return
      }
      if (!frame?.data) return
      const fmt = frame.format || 'jpeg'

      if (!hasBitmap) {
        // 폴백: createImageBitmap 이 없는 브라우저. 종전 경로 그대로다.
        let img = imgs.current[channel]
        if (!img) {
          img = new Image()
          img.onload = () => actions.setExternalFrame(channel, img, imgs.current[`${channel}_maxTemp`])
          imgs.current[channel] = img
        }
        imgs.current[`${channel}_maxTemp`] = frame.maxTemp
        img.src = `data:image/${fmt};base64,${frame.data}`
        return
      }

      // 대기 슬롯은 항상 한 칸이다. 밀리면 **덮어써서** 최신 것만 남긴다.
      pending.current[channel] = {
        blob: b64ToBlob(frame.data, `image/${fmt}`),
        maxTemp: frame.maxTemp,
      }
      pump(channel)
    })

    return () => {
      off(); decoder.close(); actions.clearExternalFrames()
      // 남은 비트맵 정리 — 언마운트 후에도 살아 있으면 GPU 메모리가 잡힌 채 남는다.
      for (const k of Object.keys(bitmaps.current)) {
        const b = bitmaps.current[k]
        if (b && typeof b.close === 'function') b.close()
      }
      bitmaps.current = {}; pending.current = {}; busy.current = {}
    }
  }, [enabled, onVideoFrame, actions])

  // ---- 키보드 WASD → DRIVE 발행 ----
  // keydown은 누르고 있는 동안 반복 발생하므로 눌림 집합으로 전이만 잡고,
  // 누르고 있는 동안의 지속 주행은 아래 재전송 타이머가 담당한다(deadman 대응).
  const held = useRef(new Set<string>())
  const repeat = useRef<any>(null)

  useEffect(() => {
    if (!enabled || !connected) return undefined

    const resolve = (e: any) => {
      const k = e.key.toLowerCase()
      return /^[wasd]$/.test(k) ? k : null
    }
    const isTyping = (el: any) => !!el && (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable)

    // 여러 키를 동시에 눌러도 방향은 하나 — 가장 최근에 누른 키를 따른다(Set은 삽입 순서 유지).
    const currentVector = () => {
      const last = [...held.current].pop()
      return (last && DRIVE_VECTORS[last]) || null
    }
    const sendCurrent = () => {
      const v = currentVector()
      if (v) control.drive(v.linear, v.angular)
    }

    const stopRepeat = () => {
      if (!repeat.current) return
      clearInterval(repeat.current)
      repeat.current = null
    }
    const startRepeat = () => {
      if (repeat.current) return
      repeat.current = setInterval(() => {
        const v = currentVector()
        if (!v) { stopRepeat(); return } // 방어적 — 눌린 키가 없으면 타이머를 남기지 않는다
        control.drive(v.linear, v.angular)
      }, DRIVE_REPEAT_MS)
    }

    const onDown = (e: any) => {
      if (isTyping(e.target)) return
      const k = resolve(e)
      if (!k || held.current.has(k)) return
      // 순찰 모드에서는 주행 명령이 무효다 — 모드 전환은 스페이스바만 한다(S15P11E101-513).
      // 여기서 막지 않으면 순찰 중 WASD 가 그대로 DRIVE 로 나간다.
      if (driveMode !== 'manual') return
      held.current.add(k)
      sendCurrent() // 첫 명령은 타이머를 기다리지 않고 즉시 보낸다
      startRepeat()
    }
    const onUp = (e: any) => {
      const k = resolve(e)
      if (!k || !held.current.has(k)) return
      held.current.delete(k)
      // 아직 눌려 있는 키가 있으면 그 방향으로 이어가고, 없으면 재전송을 끊고 즉시 정지
      if (held.current.size) sendCurrent()
      else { stopRepeat(); control.stop() }
    }
    // 창을 벗어나면 keyup을 못 받으므로 안전하게 정지시킨다
    const onBlur = () => {
      if (!held.current.size) return
      held.current.clear()
      stopRepeat()
      control.stop()
    }

    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
      onBlur()    // 정지 발행 (눌린 키가 있을 때만)
      stopRepeat() // 눌린 키가 없어도 타이머는 확실히 해제한다
    }
  }, [enabled, connected, control, driveMode])

  return null
}
