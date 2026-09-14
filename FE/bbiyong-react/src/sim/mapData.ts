// 로봇 지도 · A* 경로탐색 · 순찰 루프 (원본 index.html의 로직을 그대로 이식)

// 0 = 이동 가능, 1 = 장애물(SLAM 점유격자)
export const MAP = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 0, 0],
  [0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0],
  [0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0],
  [0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0],
  [0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0],
  [0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
]

export const RS = MAP.length       // 행 수
export const CSn = MAP[0].length    // 열 수

// A* 최단 회피 경로 (맨해튼 휴리스틱)
export function astar(s: any, g2: any) {
  const key = (c: any, r: any) => r * CSn + c
  /** 탐색 노드. p 는 부모(경로 역추적용) — 시작 노드만 null 이다 */
  type Node = { c: number, r: number, g: number, f: number, p: Node | null }
  const open: Node[] = [{ c: s.c, r: s.r, g: 0, f: 0, p: null }]
  const gsc: Record<number, number> = {}
  gsc[key(s.c, s.r)] = 0
  const H = (c: any, r: any) => Math.abs(c - g2.c) + Math.abs(r - g2.r)
  while (open.length) {
    open.sort((a, b) => a.f - b.f)
    const cur = open.shift()!  // while(open.length) 이 보장한다
    if (cur.c === g2.c && cur.r === g2.r) {
      const o = []
      let n: Node | null = cur
      while (n) { o.unshift({ c: n.c, r: n.r }); n = n.p }
      return o
    }
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = cur.c + dc, nr = cur.r + dr
      if (nc < 0 || nr < 0 || nc >= CSn || nr >= RS || MAP[nr][nc] === 1) continue
      const ng = cur.g + 1, k = key(nc, nr)
      if (gsc[k] === undefined || ng < gsc[k]) {
        gsc[k] = ng
        open.push({ c: nc, r: nr, g: ng, f: ng + H(nc, nr), p: cur })
      }
    }
  }
  return []
}

// 상시 순찰 루프 (네 모서리를 A*로 이어붙인 폐곡선)
export const loop = (() => {
  const w = [{ c: 0, r: 0 }, { c: 11, r: 0 }, { c: 11, r: 7 }, { c: 0, r: 7 }]
  let o = [{ ...w[0] }]
  for (let i = 1; i <= w.length; i++) {
    const p = astar(w[i - 1], w[i % w.length])
    for (let j = 1; j < p.length; j++) o.push(p[j])
  }
  o.pop()
  return o
})()

export const PANELS = [
  { c: 4, r: 0, n: 'A' },
  { c: 11, r: 4, n: 'B' },
  { c: 7, r: 7, n: 'C' },
]
export const FIREC = { c: 8, r: 2 }
export const speed = { patrol: 0.02, fast: 0.05 }
