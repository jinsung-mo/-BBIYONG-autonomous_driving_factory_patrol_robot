// 프로젝트 전역 공용 타입 정의 (TypeScript 전환).
// 원본 JS의 런타임 형태를 그대로 서술한다 — 동작은 변하지 않는다.

// ---- 지도 / 좌표 ----
export interface Cell {
  c: number
  r: number
}

// ---- 로그 ----
export type LogKind = 'ok' | 'heat' | 'fire'

export interface LogEntry {
  id: number
  time: string
  kind: LogKind
  msg: string
}

export type LogVariant = 'alist' | 'elog'

// ---- CCTV / PTZ / 화재 감지 ----
export interface Ptz {
  x: number
  y: number
  z: number
}

export interface Detection {
  flameState: string
  flamePct: string
  smokeState: string
  smokePct: string
}

// ---- 로봇 ----
export type BotMode = 'patrol' | 'goto' | 'dispatch' | 'manual'

export interface Bot {
  pos: Cell
  seg: number
  prog: number
  mode: BotMode
  route: Cell[]
  rs: number
  rp: number
  hd: number
}

export type SegMode = 'patrol' | 'manual'

export type SwitchName = 'power' | 'light' | 'ultra' | 'siren'
export type Switches = Record<SwitchName, boolean>

// ---- 시뮬레이션 스냅샷 (Simulation.snapshot 반환값) ----
export interface Snapshot {
  fireOn: boolean
  heatOn: boolean
  soundOn: boolean
  ptz: Ptz
  det: Detection
  seg: SegMode
  modeText: string
  modeClass: string
  spd: string
  rcamHud: string
  batt: number
  envT: string
  envH: string
  switches: Switches
  thermalMax: string
  thermalColor: string
  logs: LogEntry[]
}

// ---- UI 상태 ----
export type Tab = 'cctv' | 'robot'
export type Theme = 'dark' | 'light'
export type KeyName = 'w' | 'a' | 's' | 'd'
export type ActiveKeys = Record<KeyName, boolean>

// ---- 캔버스 ref / 액션 (useSimulation 노출) ----
export type CanvasName = 'cam3' | 'bigcam' | 'conf' | 'rcam' | 'tcam' | 'map2d'
export type CanvasRefCallback = (el: HTMLCanvasElement | null) => void
export type SimRefs = Record<CanvasName, CanvasRefCallback>

export interface SimActions {
  toggleFire: () => void
  toggleHeat: () => void
  toggleSound: () => void
  ptzMove: (dir: string) => void
  ptzZoom: (delta: number) => void
  setSeg: (man: boolean) => void
  dpadMove: (dir: string) => void
  dpStop: () => void
  emergencyStop: () => void
  reset: () => void
  returnPatrol: () => void
  goto: (value: string, label?: string) => void
  toggleSwitch: (name: string) => void
}

// useSimulation() 이 반환하고 SimContext 로 트리에 공급하는 번들
export interface SimBundle {
  status: Snapshot
  clock: string
  activeTab: Tab
  setTab: (tab: Tab) => void
  activeKeys: ActiveKeys
  refs: SimRefs
  actions: SimActions
  theme: Theme
  toggleTheme: () => void
}

// ---- 인증 ----
export interface Session {
  email: string
}

// localStorage 목 저장소의 회원 레코드 (비밀번호 포함)
export interface StoredUser {
  email: string
  password: string
  name: string
  role: string
}

// 비밀번호를 제외한 공개 유저 정보
export interface User {
  email: string
  name: string
  role: string
}

export interface AuthContextValue {
  user: User | null
  login: (email: string, password: string) => void
  signup: (payload: { email: string; password: string; name: string }) => void
  logout: () => void
  changePassword: (current: string, next: string) => void
  updateProfile: (patch: Partial<Pick<User, 'name' | 'role'>>) => void
}
