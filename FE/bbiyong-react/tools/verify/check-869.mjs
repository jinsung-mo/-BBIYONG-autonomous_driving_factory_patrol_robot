// 순찰 마스크(patrol_mask) 계약 검증 — S15P11E101-869 / 재발 방지.
//
// 파일명이 -869 인 이유: 이 폴더의 스크립트는 '고친 티켓'이 아니라 '검사하는 기능'의
// 번호를 쓴다. 마스크 기능 자체가 -869 다. 이 파일을 들여온 수정은 S15P11E101-900,
// 같은 방식을 나머지 필드(orinPower·readiness·charging)로 넓히는 후속은 S15P11E101-901.
//
// 브라우저를 띄우지 않는다. 로봇이 실제로 보내는 MAP 패킷 모양을 그대로 만들어
// FE 의 판정 함수에 먹이고, "벽에 붙은 칸이 정말로 막히는가"를 잰다.
//
// 왜 이 검사가 있나 —
//   FE 가 필드를 `patrolMask`(camelCase) / 런 배열을 `data` 로 읽고 있었다. 로봇은
//   `patrol_mask` / `cells` 로 보낸다. 타입도 빌드도 통과했고 화면도 멀쩡해 보였다.
//   마스크만 조용히 null 이 되어, 벽에 붙은 자리도 그대로 찍혔다(2026-08-09 관측 2회).
//   같은 계열의 함정을 orinPower(-814) · readiness(-885) · charging(-884) 에서
//   이미 세 번 겪었다. 이름이 어긋나도 아무도 소리를 내지 않는다는 것이 핵심이다.
//   👉 그래서 "로봇이 보내는 원문 그대로"를 고정해 두고 검사한다.
//
// 실행: node tools/verify/check-869.mjs
//
// 정본 계약: orin-live-backup/20260808-patrolmask/patrol_mask_contract.md (개인 저장소)
// 로봇 구현: ~/orin-dashboard/patrol_mask.py · nav_bridge.py
import { patrolMaskBlock, decodePatrolMask, isMasked } from '../../src/live/navMap.ts'

let fail = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) fail++
}

// 4×3 격자. 아래(y=0) 줄만 순찰 가능(1), 나머지 두 줄은 벽 근처라 불가(0).
// row-major, y=0 이 아래 줄 — cells 와 같은 규칙이다.
const W = 4, H = 3, RES = 0.5, OX = -1, OY = -1
const packet = {
  type: 'MAP', source: 'robot', robot_id: 'orinka_01',
  schema_version: '1.0', kind: 'snapshot', sequence: 18,
  w: W, h: H, res: RES, ox: OX, oy: OY,
  encoding: 'rle-v1',
  cells: [0, W * H],
  patrol_mask: {
    schema: 1,
    encoding: 'rle-v1',
    cells: [1, 4, 0, 8],          // 아래 줄 4칸만 1
    geometry: { w: W, h: H, res: RES, ox: OX, oy: OY },
    revision: 3,
    stamp: 1786190341.564,
    clearance_m: 0.348,
    stats: { total: 12, reachable: 4, rotatable: 4, patrolable: 4 },
  },
}
const map = { w: W, h: H, res: RES, ox: OX, oy: OY }
// 셀 중심 좌표: x = ox + (cx + 0.5) * res
const at = (cx, cy) => ({ x: OX + (cx + 0.5) * RES, y: OY + (cy + 0.5) * RES })

// 1. 로봇 원문(snake_case + cells)을 읽어야 한다 — 이게 깨졌던 지점이다.
const block = patrolMaskBlock(packet)
check('patrol_mask(snake_case) 블록을 찾는다', !!block)
check('런 배열 이름은 cells 다', !!block?.cells)

const mask = decodePatrolMask(block, W, H)
check('디코드 결과 길이 = w*h', mask?.length === W * H)
check('아래 줄은 순찰 가능(1)', mask && [...mask.slice(0, 4)].every((v) => v === 1))
check('윗 두 줄은 불가(0)', mask && [...mask.slice(4)].every((v) => v === 0))

// 2. 클릭 판정 — 이 두 줄이 곧 화면에서 본 증상이다.
const free = at(1, 0)
const blocked = at(1, 2)
check('자유 칸은 통과한다', isMasked(mask, map, free.x, free.y) === false)
check('벽 붙은 칸은 막힌다', isMasked(mask, map, blocked.x, blocked.y) === true)

// 3. 하위호환 — 마스크가 없으면 종전대로 아무 데나 찍힌다(전부 0 으로 대체하지 않는다).
const { patrol_mask: _omit, ...noMask } = packet
check('마스크가 없으면 블록도 없다', patrolMaskBlock(noMask) === null)
check('마스크 없으면 클릭이 막히지 않는다', isMasked(null, map, blocked.x, blocked.y) === false)

// 4. 격자가 어긋난 마스크는 버린다 — 엉뚱한 칸을 막느니 안 막는 편이 낫다.
const shifted = { ...packet, patrol_mask: { ...packet.patrol_mask, geometry: { w: W, h: H, res: RES, ox: OX + 1, oy: OY } } }
check('격자 불일치 마스크는 버린다', patrolMaskBlock(shifted) === null)

// 5. revision — 마스크가 바뀌어도 지도 sequence 는 오르지 않는다(계약 §6).
//    LiveContext 가 sequence 만 보고 건너뛰면 마스크가 영영 낡는다.
check('revision 을 읽을 수 있다', block.revision === 3)

console.log(fail ? `\n${fail} FAIL` : '\n모두 통과')
process.exit(fail ? 1 : 0)
