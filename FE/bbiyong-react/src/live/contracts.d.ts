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
  /** 초 */
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
  /** 로그인 응답 expiresIn 으로 계산한 절대 만료 시각. 없으면 절대 만료를 걸지 않는다. */
  expiresAt?: number | null
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
  /** 사용자 조작·이벤트 기록을 활동으로 남긴다 */
  touch: () => void
  /** 만료 임박 경고 표시 여부 */
  warning: boolean
  extendSession: () => void
  logoutReason: LogoutReason | null
  clearLogoutReason: () => void
}
