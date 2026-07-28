// LiveContext(STOMP) → Simulation(캔버스) 연결 다리.
//
// 렌더링은 아무것도 하지 않는다. live 모드일 때 실서버에서 받은
// 로봇 위치와 카메라 프레임을 기존 캔버스 렌더러에 밀어 넣어,
// 2D 지도·전면 카메라·열화상이 시뮬 대신 실제 데이터를 그리게 한다.

import { useEffect, useRef } from 'react'
import { useSim } from '../SimContext.js'
import { useLive } from './LiveContext.jsx'
import { worldToCell } from './config.js'
import { DRIVE_VECTORS } from './mappers.js'

export default function LiveSimBridge() {
  const { actions } = useSim()
  const { enabled, connected, telemetry, onVideoFrame, control } = useLive()

  // 채널별로 Image 하나를 재사용한다 (프레임마다 새로 만들면 GC 부담이 크다)
  const imgs = useRef({ FRONT: null, THERMAL: null })

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

    const off = onVideoFrame((channel, frame) => {
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

    return () => { off(); actions.clearExternalFrames() }
  }, [enabled, onVideoFrame, actions])

  // ---- 키보드 WASD → DRIVE 발행 ----
  // keydown은 누르고 있는 동안 반복 발생하므로 눌림 집합으로 전이만 잡아 발행한다.
  const held = useRef(new Set())
  useEffect(() => {
    if (!enabled || !connected) return undefined

    const arrowMap = { arrowup: 'w', arrowdown: 's', arrowleft: 'a', arrowright: 'd' }
    const resolve = (e) => {
      let k = e.key.toLowerCase()
      if (arrowMap[k]) k = arrowMap[k]
      return 'wasd'.includes(k) ? k : null
    }
    const onDown = (e) => {
      const k = resolve(e)
      if (!k || held.current.has(k)) return
      held.current.add(k)
      const v = DRIVE_VECTORS[k]
      control.drive(v.linear, v.angular)
    }
    const onUp = (e) => {
      const k = resolve(e)
      if (!k || !held.current.has(k)) return
      held.current.delete(k)
      // 아직 눌려 있는 키가 있으면 그 방향을 이어가고, 없으면 정지
      const next = [...held.current].pop()
      if (next) { const v = DRIVE_VECTORS[next]; control.drive(v.linear, v.angular) }
      else control.stop()
    }
    // 창을 벗어나면 키를 뗀 이벤트를 못 받으므로 안전하게 정지시킨다
    const onBlur = () => { if (held.current.size) { held.current.clear(); control.stop() } }

    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
      onBlur()
    }
  }, [enabled, connected, control])

  return null
}
