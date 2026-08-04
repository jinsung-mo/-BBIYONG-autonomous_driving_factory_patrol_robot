/// <reference types="vite/client" />
// ^ import.meta.env 타입. Vite 가 제공하며 런타임 산출물과는 무관하다.

// 서버·로봇과 주고받는 계약 (S15P11E101-569).
//
// BE record / 로봇 payload 를 그대로 옮겨 적은 것이다. 여기 적힌 이름과 선택 여부(?)가
// 실제 코드와 어긋나면 그게 곧 결함이다 — 지금까지 겪은 사고가 전부 이 지점이었다.
//
// 근거:
//   BE_system  .../stomp/dto/ControlCommand.java · event/dto/AlertMessage.java
//              event/domain/EventLog.java · event/dto/EventPageResponse.java
//              map/dto/MapResponses.java · map/domain/MapArtifact.java
//              waypoint/dto/WaypointRequest.java · WaypointResponses.java
//              equipment/domain/Equipment.java · settings/dto/DriveSpeed*.java
//              robot/dto/RobotResponse.java · auth/dto/LoginResponse.java
//   BE_robot   orin_dashboard/cloud_bridge.py (build_telemetry · build_map · build_nav_live)
//   문서       docs/fe_backend_integration_guide.md · docs/backend_api_specification.md
//
// 이 파일은 .d.ts 라 런타임 산출물에 아무 영향이 없다.

// ---------------------------------------------------------------- 열거

/** 로봇 서브시스템 생존 상태. 브리지가 /tmp 파일 mtime 으로 판정해 보고한다. */
export type CapabilityState = 'online' | 'stale' | 'offline'

/** 화면에서만 쓰는 값 — capabilities 자체가 없을 때(=보고하지 않는 로봇). */
export type CapabilityUnknown = 'unknown'

/**
 * 서버 RobotPacket.status 가 기대하는 값.
 * 다만 cloud_bridge.infer_status() 는 AUTO_PATROL / MANUAL_CONTROL / (없음) 만 낸다 —
 * APPROACH·VERIFY·MAPPING 은 서버가 정의만 해 둔 상태다.
 */
export type RobotStatus =
  | 'AUTO_PATROL' | 'APPROACH' | 'VERIFY' | 'MANUAL_CONTROL' | 'MAPPING'
  /** RobotService 가 무수신 임계를 넘겼을 때 REST 응답에 채우는 값 */
  | 'OFFLINE'

export type EstopState = 'RELEASED' | 'ENGAGED'

/** 이벤트 종류. SYSTEM 은 EventLog 주석에만 있고 실제 생성 지점은 아직 없다. */
export type EventType = 'FIRE' | 'OVERHEAT' | 'SYSTEM'

export type EventLevel = 'CRITICAL' | 'WARNING'

export type EventStatus = 'UNRESOLVED' | 'RESOLVED'

export type EquipmentStatus = 'NORMAL' | 'OVER' | 'UNKNOWN'

/** 맵 산출물 종류. null 이면 RAW 취급(MapArtifact 주석). */
export type MapKind = 'RAW' | 'FLOORPLAN'

/** SET_MODE 로 보낼 수 있는 값. 가이드 §5 — 이 셋뿐이다. */
export type DriveMode = 'autonomy' | 'manual' | 'disabled'

export type Role = 'ROLE_ADMIN' | 'ROLE_VIEWER'

// ---------------------------------------------------------------- STOMP 수신

/** 미터·map 프레임. 로봇이 TF 를 못 잡으면 통째로 생략된다. */
export interface RobotLocation {
  x?: number
  y?: number
  yaw?: number
}

export type Capabilities = Partial<Record<
  'camera' | 'thermal' | 'lidar_map' | 'nav' | 'drive' | 'fire',
  CapabilityState
>>

/**
 * /topic/robots — 서버가 로봇 패킷을 그대로 직렬화해 중계한다.
 *
 * 브리지는 값이 없으면 null 로 채우지 않고 **필드를 생략**한다. 그래서 거의 모두 선택이다 —
 * '보고하지 않음' 과 '0' 은 다른 뜻이고, 화면도 그렇게 구분해야 한다.
 */
export interface RobotTelemetry {
  source?: 'robot'
  type?: 'TELEMETRY'
  robotId?: string
  /** 로봇 원문은 snake_case 로 보낸다. 서버 직렬화에 따라 둘 다 올 수 있어 함께 둔다. */
  robot_id?: string
  location?: RobotLocation
  battery?: number
  speed?: number
  status?: RobotStatus
  estop?: EstopState
  commLatencyMs?: number
  inferenceFps?: number
  capabilities?: Capabilities
  timestamp?: number | string
  /** 카메라 상하 각도(도). 로봇 계약 미확정 — S15P11E101-521 */
  cameraTilt?: number
  camera_tilt?: number
  tilt?: number
}

/** /topic/alerts — 로봇이 확정한 화재·과열. AlertMessage record 그대로. */
export interface AlertMessage {
  type: 'FIRE' | 'OVERHEAT'
  level?: EventLevel
  source?: string
  robotId?: string
  /** FIRE 전용 */
  confidence?: number
  temperature?: number
  /** OVERHEAT 전용 */
  equipmentId?: string
  threshold?: number
  /** OVERHEAT 전용 열화상 base64 — 중계만 하고 저장하지 않는다 */
  thermalImage?: string
  x?: number
  y?: number
  message?: string
  timestamp?: string
  /** 실시간 수신분에 FE 가 붙이는 로컬 식별자. 서버 필드가 아니다. */
  _id?: number
}

/**
 * /topic/nav/{robotId} — 점유격자 스냅샷.
 * cells 는 flat RLE([값, 개수, ...]) 이고 서버는 해석하지 않고 그대로 중계한다.
 */
export interface MapSnapshot {
  type: 'MAP'
  robot_id?: string
  sequence: number
  w: number
  h: number
  /** m/셀 */
  res: number
  /** 맵 원점(미터, ROS map 규약) */
  ox: number
  oy: number
  encoding?: string
  cells: number[]
}

/** nav_bridge 포맷. ranges[i] === 0 은 무효 측정이다. */
export interface LidarScan {
  angle_min: number
  angle_inc: number
  ranges: number[]
}

export interface NavPose {
  frame?: string
  x: number
  y: number
  yaw: number
}

/** /topic/nav/{robotId} — 실시간 자세·스캔(3Hz). */
export interface NavLive {
  type: 'NAV_LIVE'
  robot_id?: string
  t?: number
  map_sequence?: number
  pose?: NavPose
  scan?: LidarScan
}

/** /topic/mapping — 로봇 원문 relay. 매핑이 끝났다는 뜻. */
export interface MappingComplete {
  type: 'EVENT_MAPPING_COMPLETE' | 'MAPPING_COMPLETE'
  robot_id?: string
  robotId?: string
  /** 로봇이 붙인 맵 이름 */
  name?: string
  /** FE 가 수신 시각을 붙인다. 서버 필드가 아니다. */
  _at?: number
}

/** /topic/mapping — 서버가 정제 도면을 만들어 활성화했다(S15P11E101-518). */
export interface FloorplanReady {
  type: 'FLOORPLAN_READY'
  robotId?: string
  mapId: string
  imageUrl: string
  _at?: number
}

/** 매핑 토픽으로 오는 두 종류. 도착 자체를 완료로 보면 안 된다(S15P11E101-524). */
export type MappingMessage = MappingComplete | FloorplanReady

// ---------------------------------------------------------------- STOMP 발행

/**
 * 제어 명령. command 값에 따라 필요한 필드가 다르므로 판별 유니온으로 둔다 —
 * SET_MODE 에 linear 를 실어 보내는 류의 실수를 빌드에서 잡기 위한 것이다.
 *
 * destination 은 명령마다 정해져 있다(RobotControlStompController):
 *   /app/control/drive     DRIVE
 *   /app/control/mode      SET_MODE · ESTOP
 *   /app/control/operation NAVIGATE · SAVE_MAP · START_MAPPING
 */
export interface DriveCommand {
  command: 'DRIVE'
  /** m/s */
  linear: number
  /** rad/s */
  angular: number
}

export interface SetModeCommand {
  command: 'SET_MODE'
  mode: DriveMode
}

/** fail-safe — active:true 만 유효하다. 해제 명령은 없다. */
export interface EstopCommand {
  command: 'ESTOP'
  active: true
}

export interface NavigateCommand {
  command: 'NAVIGATE'
  /** 미터·map 프레임 */
  x: number
  y: number
  yaw?: number
}

export interface SaveMapCommand {
  command: 'SAVE_MAP'
  name: string
}

export interface StartMappingCommand {
  command: 'START_MAPPING'
}

/**
 * 카메라 상하 각도(S15P11E101-521).
 *
 * **로봇 계약에 없는 잠정 명령이다.** cloud_bridge.handle_command 는 DRIVE·ESTOP 만 알고
 * BE ControlCommand 에도 카메라 필드가 없다. 이름·단위·범위가 확정되면 여기와
 * cameraTilt.js 를 함께 고친다.
 */
export interface SetCameraTiltCommand {
  command: 'SET_CAMERA_TILT'
  /** 도(°). 위가 + */
  tilt: number
}

/**
 * 발행부가 만드는 본문(robot_id 제외). send() 가 robot_id 를 붙여 실제 명령이 된다.
 * 유니온이라 command 값에 맞지 않는 필드를 실으면 빌드에서 걸린다.
 */
export type ControlCommandBody =
  | DriveCommand
  | SetModeCommand
  | EstopCommand
  | NavigateCommand
  | SaveMapCommand
  | StartMappingCommand
  | SetCameraTiltCommand

/** 실제로 STOMP 로 나가는 형태. */
export type ControlCommand = ControlCommandBody & { robot_id: string }

// ---------------------------------------------------------------- REST

/** POST /api/auth/login */
export interface LoginResponse {
  tokenType: string
  accessToken: string
  /**
   * access 재발급용. S15P11E101-608 에서 추가됐다 —
   * 이 필드가 없는 응답(구버전 서버)도 그대로 동작해야 한다.
   */
  refreshToken?: string
  /** 초. 608 이전 24시간(86400) → 이후 1시간(3600). 값을 그대로 쓴다. */
  expiresIn: number
  role: Role | string
}

/** POST /api/auth/refresh 응답 — 로그인 응답과 같은 형태다(refreshToken 도 새로 온다). */
export interface RefreshResponse {
  tokenType: string
  accessToken: string
  refreshToken?: string
  expiresIn: number
  role: Role | string
}

/** GET /api/events 의 한 건 — EventLog 엔티티 그대로. */
export interface EventLog {
  eventId: number
  type: EventType
  level?: EventLevel
  robotId?: string
  equipmentId?: string
  x?: number
  y?: number
  confidence?: number
  temperature?: number
  threshold?: number
  message?: string
  timestamp?: string
  status?: EventStatus
}

/** GET /api/events — Spring Page 를 감싼 응답. */
export interface EventPage {
  content: EventLog[]
  page?: number
  size?: number
  totalPages?: number
  totalElements?: number
}

/** GET /api/robots — 서버가 판정한 online 을 포함한다. */
export interface RobotResponse {
  robotId: string
  name?: string
  status?: RobotStatus
  battery?: number
  speed?: number
  estop?: EstopState
  commLatencyMs?: number
  inferenceFps?: number
  lastConnected?: string
  location?: RobotLocation
  /** 로봇 WSS 세션이 열려 있는지. 예전 서버는 주지 않을 수 있다. */
  online?: boolean
}

/** GET /api/maps 의 한 건. */
export interface MapSummary {
  id: string
  name?: string
  robotId?: string
  imageUrl?: string
  active?: boolean
  kind?: MapKind
  createdAt?: string
  widthPx?: number
  heightPx?: number
  resolution?: number
}

/** GET /api/maps/{id} · /latest · /active */
export interface MapDetail extends MapSummary {
  widthPx?: number
  heightPx?: number
  /** m/px */
  resolution?: number
  /** 맵 원점(미터, ROS map 규약) */
  originX?: number
  originY?: number
  originYaw?: number
  fileSizeBytes?: number
  sourceMapId?: string
}

/** POST/PUT /api/waypoints 의 요청 한 건. x/y 는 미터·map 프레임이다. */
export interface WaypointRequest {
  x: number
  y: number
  yaw?: number
  name?: string
  seq?: number
}

/** /api/waypoints 응답 한 건. */
export interface Waypoint {
  id: string
  robotId?: string
  name?: string | null
  x: number
  y: number
  yaw?: number | null
  seq?: number
  createdAt?: string
}

/** POST /api/waypoints/apply — 로봇 미연결이어도 200 이고 delivered 로 갈린다. */
export interface WaypointApplyResult {
  status?: string
  delivered?: boolean
  count?: number
}

/** GET/PUT /api/equipments — Equipment 엔티티 그대로. */
export interface Equipment {
  equipmentId: string
  name?: string
  x?: number
  y?: number
  /** 로봇 판정 임계치의 표시용 참고값(authoritative 값은 로봇 보유) */
  threshold?: number
  lastTemperature?: number | null
  lastInspectedAt?: string | null
  status?: EquipmentStatus
}

/** GET/PUT /api/settings/drive-speed. delivered 는 수정 시에만 온다(조회 시 null). */
export interface DriveSpeed {
  robotId?: string
  maxLinear: number
  maxAngular: number
  delivered?: boolean | null
  updatedAt?: string | null
}

/** 인가 실패를 호출부가 상태 코드로 분기할 수 있게 error.status 를 실어 던진다. */
export interface HttpError extends Error {
  status?: number
}

// ---------------------------------------------------------------- FE 내부 파생 형태
//
// 서버 계약이 아니라, 위 payload 를 화면이 쓰기 좋게 바꾼 결과다.
// 계약이 바뀌면 이쪽도 따라 바뀌므로 같은 파일에 둔다.

/** MapSnapshot 을 디코드한 결과(navMap.decodeMapSnapshot). data 는 셀당 한 글자다. */
export interface DecodedMap {
  w: number
  h: number
  /** m/셀 */
  res: number
  ox: number
  oy: number
  seq: number
  /** '#' 벽 · ' ' 자유 · '.' 미탐색 (row-major, 아래→위) */
  data: string
}

/** 활성 도면(floorplan.loadActivePlan). 배치 기하는 DecodedMap 과 같은 규칙이다. */
export interface PlanLayer {
  id: string
  name?: string
  kind: MapKind | string
  img: HTMLImageElement
  /** objectURL — 교체·해제 시 revoke 해야 한다 */
  url: string
  /** px */
  w: number
  h: number
  /** m/px */
  res: number
  ox: number
  oy: number
  /**
   * 원점 회전각(radians, ROS map 규약). 0 이면 축에 나란하다.
   * 이 값을 무시하면 회전된 맵이 어긋나게 그려지고, 조작자가 보고 찍은 자리가
   * 실제 월드 좌표와 달라진다(S15P11E101-629).
   */
  oyaw?: number
}

/** 지도에 그릴 배경 하나(navMap.backgroundOf). */
export interface MapBackground {
  img: CanvasImageSource
  w: number
  h: number
  res: number
  ox: number
  oy: number
  /** 정제 도면이면 true — 확대 보간 여부가 갈린다 */
  isPlan: boolean
}

/** LiveContext 가 ref 로 들고 있는 지도 상태. 리스너가 이 객체를 그대로 받는다. */
export interface NavState {
  map: DecodedMap | null
  mapCanvas: HTMLCanvasElement | null
  pose: NavPose | null
  scan: LidarScan | null
  /** [x, y] 미터 */
  trail: Array<[number, number]>
  plan?: PlanLayer | null
}

/** 지도 팬·줌 상태(navMap.makeView). */
export interface MapView {
  x: number
  y: number
  /** 픽셀/미터 */
  s: number
  init: boolean
}

// ---------------------------------------------------------------- 인증·설정 (S15P11E101-570)
//
// 서버 계약이 아니라 FE 가 브라우저에 들고 있는 상태다. 여러 파일이 함께 쓰므로 여기에 둔다.

/** 자동 로그아웃 사유. 사용자가 직접 누른 로그아웃(MANUAL)은 안내를 띄우지 않는다. */
export type LogoutReason = 'idle' | 'expired' | 'manual'

/** mock 저장소의 회원 한 건. 실서버 모드에서는 쓰지 않는다. */
export interface StoredUser {
  email: string
  password: string
  name?: string
  phone?: string
  birth?: string
  gender?: string
  role: string
}

/** 화면에 노출하는 공개 정보 — 비밀번호는 담지 않는다. */
export interface PublicUser {
  email: string
  name?: string
  /** 서버가 준 원문을 그대로 보관한다. 표시 문구로 바꿔 저장하면 권한 판정을 잃는다. */
  role: string
}

/** localStorage `bbiyong.session` — mock 모드 세션. */
export interface StoredSession {
  email: string
}

/** localStorage `bbiyong.token` — 실서버 세션. */
export interface StoredAuth {
  accessToken: string
  user: PublicUser
  /**
   * access 재발급용(S15P11E101-613). 서버가 주지 않으면 없다 —
   * 그때는 예전처럼 절대 만료에 걸려 로그아웃된다.
   */
  refreshToken?: string | null
  /** 로그인 응답 expiresIn 으로 계산한 절대 만료 시각. 없으면 절대 만료를 걸지 않는다. */
  expiresAt?: number | null
  /**
   * 그때 받은 access 수명(초). 선제 갱신 여유를 수명에 맞춰 줄이는 데 쓴다 —
   * 수명이 여유보다 짧으면 발급 즉시 갱신 조건이 서서 갱신이 반복된다(S15P11E101-613).
   */
  expiresIn?: number | null
}

/** 순찰 지점(설정 탭). 좌표는 미터·map 프레임이다. */
export interface PatrolPoint {
  id: string
  label: string
  x: number
  y: number
}

/** 운영 설정. 주행 상한은 서버가 정답이고 나머지는 이 브라우저에만 저장된다. */
export interface Settings {
  /** 선속도 상한 (m/s) */
  vMax: number
  /** 각속도 상한 (rad/s) */
  wMax: number
  /** 열화상 화면 표시 기준 — 로봇의 과열 판정 기준(Equipment.threshold)과는 다른 값이다 */
  tempWarn: number
  tempCritical: number
  points: PatrolPoint[]
}

export interface SettingsContextValue {
  settings: Settings
  update: (patch: Partial<Settings>) => void
  reset: () => void
  /** 서버 주행 상한을 한 번이라도 받았는지 */
  driveSynced: boolean
}

export interface AuthContextValue {
  user: PublicUser | null
  accessToken: string | null
  login: (email: string, password: string) => Promise<void>
  signup: (form: {
    email: string, password: string, name?: string,
    phone?: string, birth?: string, gender?: string,
  }) => Promise<void>
  logout: (reason?: LogoutReason) => void
  changePassword: (current: string, next: string) => void
  updateProfile: (patch: Partial<StoredUser>) => void
  isAdmin: boolean
  /**
   * 조작해도 되는가 — 권한이 있고 잠기지 않았을 때만 true(S15P11E101-653).
   * `isAdmin` 은 '무엇을 보여 줄지', `canOperate` 는 '무엇을 누르게 할지'에 쓴다.
   */
  canOperate: boolean
  /** 사용자 조작·이벤트 기록을 활동으로 남긴다 */
  touch: () => void
  /**
   * 조작 잠금 상태(S15P11E101-653). 유휴가 지나면 로그아웃하지 않고 여기가 true 가 된다 —
   * 세션과 화면은 그대로 살아 있고 조작만 막힌다.
   */
  locked: boolean
  /** 비밀번호를 다시 확인해 잠금을 푼다. 틀리면 던지고 잠금은 유지된다. */
  unlock: (password: string) => Promise<void>
  /** 자리를 뜨며 직접 잠근다 */
  lockNow: () => void
  logoutReason: LogoutReason | null
  clearLogoutReason: () => void
  /** 서버가 403 을 줬을 때 서버 판단 role 을 다시 받아 온다(S15P11E101-626) */
  syncRole: () => Promise<void>
}

/** LiveProvider 가 공급하는 값 (S15P11E101-576). */
export interface LiveContextValue {
  /** live 모드인지 (mock 이면 false) */
  enabled: boolean
  connected: boolean
  lastError: string | null
  authError: boolean
  hasToken: boolean
  dataSource: 'live' | 'mock'
  setDataSource: (v: 'live' | 'mock') => void
  toggleDataSource: () => void
  telemetry: RobotTelemetry | null
  alerts: AlertMessage[]
  dismissAlert: (id: number) => void
  onVideoFrame: (fn: (ch: 'FRONT' | 'THERMAL', frame: any) => void) => () => void
  onNavUpdate: (fn: (nav: NavState) => void) => () => void
  videoSeen: Record<string, boolean>
  control: {
    drive: (linear: number, angular: number) => void
    stop: () => void
    setMode: (mode: DriveMode) => void
    estop: () => void
    navigate: (x: number, y: number, yaw?: number) => void
    setCameraTilt: (deg: number) => void
    startMapping: () => void
    stopMapping: () => void
    saveMap: (name: string) => void
  }
  robotId: string
  /** 주행 슬라이더 값 (m/s) */
  speed: number
  setSpeed: (v: number) => void
  mappingComplete: any
  clearMappingComplete: () => void
  /** 서버가 판정한 로봇 가동 여부. null = 아직 모름 */
  robotOnline: boolean | null
  /** 사용자가 고른 제어 모드 */
  driveMode: 'patrol' | 'manual'
  setDriveMode: (m: 'patrol' | 'manual') => void
  plan: PlanLayer | null
  planError: string | null
}

// ---------------------------------------------------------------- 관제센터 신규 API
//
// BE 가이드: docs/FE_CONTROL_CENTER_API_GUIDE.md
// 컨트롤러: DashboardController · EventController(stats) · NotificationController ·
//           PatrolScheduleController · RobotController(health-history)
//
// 응답 필드는 BE DTO 를 그대로 옮겼다. 가이드 문서에 없지만 DTO 에 있는 것
// (EventLogResponse.hasVideo, NotificationSettingResponse.id/userId/…)도 포함한다 —
// 서버가 보내는 것을 타입에서 지워 두면 나중에 쓸 때 캐스트가 필요해진다.

/** GET /api/dashboard/stats — 관제 요약 4종을 한 번에 받는다. */
export interface DashboardStats {
  summary: RobotSummary
  today: TodayStats
  /** 설비(분전반) 집계. S15P11E101-573 에서 추가됐다 — 예전 서버에는 없다. */
  equipment?: EquipmentSummary
  /** 설비 목록. 설정 탭의 /api/equipments 와 같은 형태다. */
  equipmentStatus?: Equipment[]
  recentEvents: EventLog[]
  robotStatus: RobotResponse[]
}

/** 설비 상태 집계(S15P11E101-630). 필드 이름은 BE EquipmentSummary 그대로다. */
export interface EquipmentSummary {
  totalEquipments: number
  overheatingEquipments: number
  normalEquipments: number
  unknownEquipments: number
}

export interface RobotSummary {
  totalRobots: number
  activeRobots: number
  chargingRobots: number
  /** 소수점이 붙어 온다 (예: 78.5) */
  avgBattery: number
  onlineRobots: number
}

/** 오늘(서버 기준 자정부터) 집계. 서버가 long 으로 주므로 큰 수가 올 수 있다. */
export interface TodayStats {
  eventCount: number
  criticalEvents: number
  warningEvents: number
  resolvedEvents: number
  unresolvedEvents: number
}

/** GET /api/events 쿼리 — 모두 선택이고, 빈 값은 아예 보내지 않는다. */
export interface EventFilters {
  type?: EventType | null
  level?: EventLevel | null
  status?: EventStatus | null
  robotId?: string | null
  equipmentId?: string | null
  /** YYYY-MM-DD */
  startDate?: string | null
  endDate?: string | null
}

/** 통계 묶음 기준. by-robot·by-equipment·by-type 은 시계열이 아니라 timestamp 가 null 이다. */
export type EventStatsGroup = 'hour' | 'day' | 'robot' | 'equipment' | 'type'

export interface EventStatsPoint {
  /** 시간별 '10:00' · 일별 'MM/DD' · 그 외에는 로봇/설비/타입 ID */
  label: string
  timestamp?: string | null
  totalCount: number
  criticalCount: number
  warningCount: number
  unresolvedCount: number
  resolvedCount: number
}

export interface EventStats {
  groupBy: EventStatsGroup
  startTime?: string
  endTime?: string
  dataPoints: EventStatsPoint[]
}

/** GET/PUT /api/notifications/settings — 사용자별 Mattermost 알림 설정. */
export interface NotificationSetting {
  id?: number
  userId?: string
  mattermostEnabled: boolean
  mattermostWebhookUrl?: string | null
  mattermostChannel?: string | null
  /** CRITICAL = 긴급만 · WARNING = 경고 이상 전부 */
  minSeverity: EventLevel
  createdAt?: string
  updatedAt?: string
}

/** PUT 본문. 서버가 채우는 id·userId·시각은 보내지 않는다. */
export interface NotificationSettingRequest {
  mattermostEnabled: boolean
  mattermostWebhookUrl?: string
  mattermostChannel?: string
  minSeverity: EventLevel
}

/** GET /api/patrol-schedules — Spring cron(6필드) 으로 도는 자동 순찰 예약. */
export interface PatrolSchedule {
  scheduleId: number
  name: string
  robotId: string
  /** 초 분 시 일 월 요일 — Spring 6필드다(표준 5필드가 아니다) */
  cronExpression: string
  enabled: boolean
  lastExecuted?: string | null
  createdAt?: string
  updatedAt?: string
}

export interface PatrolScheduleRequest {
  name: string
  robotId: string
  cronExpression: string
  enabled: boolean
}

/** GET /api/robots/{id}/health-history — 차트용 시계열. */
export interface RobotHealthHistory {
  robotId: string
  startTime?: string
  endTime?: string
  /** 시간 오름차순 정렬돼 온다 */
  dataPoints: HealthDataPoint[]
}

export interface HealthDataPoint {
  timestamp: string
  battery?: number
  speed?: number
  commLatencyMs?: number
  inferenceFps?: number
  status?: string
  estop?: string
  online?: boolean
}

/** health-history 의 period 파라미터. 서버가 받는 값만 넣는다. */
export type HealthPeriod = '1h' | '6h' | '24h' | '7d' | '30d'

// ---------------------------------------------------------------- 사용자 관리 (S15P11E101-614)
//
// BE 계약: AdminUserController · UserSummaryResponse. 관리자 전용이라 비관리자에게는 403 이 온다.

/** GET /api/admin/users 의 한 건. */
export interface AdminUser {
  id: number
  email: string
  name?: string | null
  /** ROLE_ADMIN | ROLE_USER — 서버 enum 원문 */
  role: string
}

/** PATCH /api/admin/users/role 본문. role 은 표시 문구가 아니라 enum 이름이다. */
export interface ChangeRoleRequest {
  email: string
  role: string
}

/**
 * POST /api/patrol-route/start — 경로 하달 + 순찰 시작을 한 번에 한 결과(S15P11E101-625).
 * 로봇이 꺼져 있어도 200 이고, 무엇이 안 됐는지는 아래 두 불리언으로 갈린다.
 */
export interface PatrolStartResult {
  /** SUCCESS | NO_ROUTE */
  status: string
  /** SET_PATROL_ROUTE 가 로봇에 전달됐는가 */
  routeDelivered: boolean
  /** SET_MODE autonomy 가 로봇에 전달됐는가 */
  patrolStarted: boolean
  count: number
}

// ---------------------------------------------------------------- 이벤트 상세·영상 (S15P11E101-628)
//
// BE 계약: EventLogDetailResponse · VideoResponses. 영상 경로는 인증이 필요해
// <video src> 로 바로 걸 수 없다 — videos.ts 주석 참고.

/** GET /api/videos 계열의 목록 한 건. */
export interface VideoSummary {
  id: string
  robotId?: string | null
  eventId?: number | null
  /** EVENT · FIRE · OVERHEAT · PATROL 등. 서버가 문자열로 준다. */
  clipType?: string | null
  durationSec?: number | null
  /** 서버가 주는 썸네일 경로. 없으면 /api/videos/{id}/thumbnail 을 쓴다. */
  thumbnailUrl?: string | null
  startedAt?: string | null
}

/** GET /api/events/{eventId} — 목록 한 건에 연관 영상이 붙은 형태. */
export interface EventDetail extends EventLog {
  videos?: VideoSummary[]
}

/**
 * 화면 구획. 시뮬레이션에서는 관제를 지도와 카메라 두 화면으로 나눈다 —
 * 한 화면에 다 넣으면 어느 것도 크지 않다. 실서버는 'live' 하나로 유지한다.
 */
export type Section = 'live' | 'cam' | 'ops' | 'config'
