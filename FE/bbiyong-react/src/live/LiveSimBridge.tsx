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

  // 채널별로 Image 하나를 재사용한다 (프레임마다 새로 만들면 GC 부담이 크다)
  // `${ch}_maxTemp` 키도 함께 담으므로 인덱스 시그니처가 필요하다
  const imgs = useRef<Record<string, any>>({ FRONT: null, THERMAL: null })

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

    const off = onVideoFrame((channel: any, frame: any) => {
      if (frame instanceof Uint8Array) {
        decoder.push(frame)
        return
      }
      if (!frame?.data) return
      let img = imgs.current[channel]
      if (!img) {
        img = new Image()
        img.onload = () => actions.setExternalFrame(channel, img, imgs.current[`${channel}_maxTemp`])
        imgs.current[channel] = img
      }
      imgs.current[`${channel}_maxTemp`] = frame.maxTemp
      const fmt = frame.format || 'jpeg'
      img.src = `data:image/${fmt};base64,${frame.data}`
    })

    return () => { off(); decoder.close(); actions.clearExternalFrames() }
  }, [enabled, onVideoFrame, actions])

  // ---- 키보드 WASD → DRIVE 발행 ----
  // keydown은 누르고 있는 동안 반복 발생하므로 눌림 집합으로 전이만 잡고,
  // 누르고 있는 동안의 지속 주행은 아래 재전송 타이머가 담당한다(deadman 대응).
  const held = useRef(new Set<string>())
  const repeat = useRef<any>(null)

  useEffect(() => {
    if (!enabled || !connected) return undefined

    const arrowMap: Record<string, string> = { arrowup: 'w', arrowdown: 's', arrowleft: 'a', arrowright: 'd' }
    const resolve = (e: any) => {
      let k = e.key.toLowerCase()
      if (arrowMap[k]) k = arrowMap[k]
      return 'wasd'.includes(k) ? k : null
    }

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
