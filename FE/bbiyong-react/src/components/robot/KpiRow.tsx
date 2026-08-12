import { useEffect, useState } from 'react'
import { useSim } from '../../SimContext.ts'
import { useLive } from '../../live/LiveContext.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import { telemetryToStatus } from '../../live/mappers.ts'
import { fetchDashboardStats } from '../../live/dashboard.ts'

// 화면 맨 위의 큰 숫자들.
//
// 굵기가 아니라 크기로 위계를 만든다 — 숫자는 굵게 쓰지 않는다.
// 값이 없으면 '—' 로 둔다. 없는 수치를 그리면 조작자가 그것을 믿는다.
//
// 배지는 색만으로 알리지 않는다. 정상·주의·위험을 기호와 함께 준다 —
// 색각 이상에서도 읽혀야 한다.
type Tone = 'ok' | 'warn' | 'bad' | 'none'

const SIGN: Record<Tone, string> = { ok: '✓', warn: '!', bad: '⚠', none: '–' }

// 미니 바차트(스파크라인)는 걷어냈다 [사용자 지시 2026-08-09].
// S15P11E101-814 에서 디자인 시스템 v3 의 서명 요소로 넣었지만, 이 줄에 남은 KPI 셋 중
// 어느 것도 추세로 읽을 값이 아니었다 — 배터리는 잔량 게이지(아래 Gauge)로 바뀌었고,
// 로봇 상태는 값이 아니라 상태이며, 경보 건수는 숫자 하나로 충분하다.
// 되살릴 일이 있으면 git 이력에 있다(이 커밋 이전 KpiRow.tsx 의 Spark/useTrend).

/** 남은 양을 가로 막대의 **길이**로 보여 준다 — 값이 클수록 오른쪽으로 길어진다.
 *
 * 🔴 배터리에 스파크라인(세로 막대 추세)을 쓰면 안 되는 이유 [사용자 지적 2026-08-09]:
 * 스파크라인은 폭이 항상 꽉 차 있고 높이만 변한다. 그래서 33% 일 때 "막대가 8칸 다
 * 차 있는데 키만 작은" 모양이 되고, 게이지로 읽는 사람은 "거의 다 찼다"로 오해한다.
 * 게다가 배터리는 분당 0.207% 씩 줄어서(batteryRuntime.ts) 8칸 관측 구간 안에서는
 * 사실상 평평하다 — 추세로 그릴 값이 애초에 아니었다.
 *
 * 잔량은 "지금 얼마나 남았나" 하나만 답하면 되고, 그건 길이가 가장 빨리 읽힌다. */
function Gauge({ pct, tone }: { pct: number, tone: Tone }) {
  const w = Math.max(0, Math.min(100, pct))
  return (
    <div className="kpi-gauge" aria-hidden="true">
      <i className={tone} style={{ width: `${w}%` }} />
    </div>
  )
}

function Kpi({ value, unit, label, tone = 'none', note, gauge }: {
  value: string, unit?: string, label: string, tone?: Tone, note?: string,
  gauge?: number | null,
}) {
  return (
    <div className="kpi">
      <div>
        <div className="kpi-num">
          {value}{unit && <span className="unit">{unit}</span>}
        </div>
        <div className="kpi-label">{label}</div>
      </div>
      <span className={`kpi-badge ${tone}`} aria-hidden="true">{SIGN[tone]}</span>
      {/* 값이 없으면 빈 게이지조차 그리지 않는다 — 0% 로 보이면 '다 닳았다'로 읽힌다. */}
      {gauge != null && <Gauge pct={gauge} tone={tone} />}
      {note && <span className="sr-only">{note}</span>}
    </div>
  )
}

// 로봇 단계 — 타일에 들어갈 짧은 라벨과 스크린리더용 전체 문장.
//
// 왜 필요한가: 여태 이 KPI 는 'ON' / 'OFF' 두 값뿐이었다. 그래서 부팅 중·매핑 중·지도
// 저장 중·위치추정 전환 중·순찰 중이 **전부 'ON' 하나로 뭉개졌고**, 브리지가 아직 안 뜬
// 부팅 구간은 'OFF'(연결 끊김)로만 보였다. 무인 사이클에서 조작자는 "멈춘 것"과 "진행
// 중인 것"을 구별할 수 없었다. (재설계 노트 §08 '관제에서 안 보이는 것')
//
// 값 집합은 docs/계약_2026-08-12_관제_프로토콜_확장제안.md 항목 1 과 같다. 🔴 로봇이 아직
// MAPPING·AUTO_PATROL 외에는 보내지 않으므로 나머지는 당장 나타나지 않는다 — **받는 쪽을
// 먼저 만들어 두는 것이 의도다.** 로봇이 붙는 순간 화면이 따라온다.
//
// 짧은 라벨을 쓰는 이유: 이 자리는 큰 숫자용 슬롯이라 '위치추정 전환 중' 같은 문장이 들어가면
// 줄바꿈으로 타일이 깨진다. 전체 문장은 note(sr-only)로 보낸다.
const STAGE: Record<string, { short: string, full: string, tone: Tone }> = {
  BOOT: { short: '부팅', full: '부팅 중 — 클럭·전력·장치를 준비하고 있다', tone: 'warn' },
  READY: { short: '준비', full: '노드·TF·토픽 준비 완료. 지시를 기다린다', tone: 'ok' },
  MAPPING: { short: '매핑', full: '지도를 작성하고 있다', tone: 'ok' },
  SAVING: { short: '저장', full: '지도를 저장하고 있다', tone: 'ok' },
  LOCALIZING: { short: '위치추정', full: '위치추정으로 전환 중 — 초기위치를 주입하고 있다', tone: 'warn' },
  AUTO_PATROL: { short: '순찰', full: '자율 순찰 중', tone: 'ok' },
  APPROACH: { short: '접근', full: '화재 후보 지점으로 접근하고 있다', tone: 'warn' },
  VERIFY: { short: '확인', full: '근접 확인 중 — 열화상으로 교차검증하고 있다', tone: 'warn' },
  EVENT: { short: '이벤트', full: '이벤트 처리 중 — 클립을 기록·업로드하고 있다', tone: 'warn' },
  DEGRADED: { short: '중단', full: '자동 진행이 멈췄다 — 관제 확인이 필요하다', tone: 'bad' },
  MANUAL_CONTROL: { short: '수동', full: '수동 조작 중', tone: 'warn' },
}

export default function KpiRow() {
  const { status } = useSim()
  const { enabled, connected, telemetry } = useLive()
  const { accessToken } = useAuth()

  const live = enabled ? telemetryToStatus(telemetry) : null
  const batt = live ? live.batt : status.batt

  const battTone: Tone = batt == null ? 'none' : batt <= 15 ? 'bad' : batt <= 35 ? 'warn' : 'ok'

  // 경보 이벤트 — 하루 단위 집계(S15P11E101 콘솔 정리).
  // live: 서버 대시보드 통계의 '오늘 이벤트 건수'(GET /api/dashboard/stats)를 30초 주기로 갱신.
  //       세션에 떠 있는 실시간 경보 수(alerts.length)는 접속 시점에 따라 달라져 하루 집계가 아니다.
  // sim:  오늘 세션 로그 중 화재/과열 건수.
  const [todayCount, setTodayCount] = useState<number | null>(null)
  useEffect(() => {
    if (!enabled || !accessToken) { setTodayCount(null); return undefined }
    let alive = true
    const load = async () => {
      try {
        const res = await fetchDashboardStats(accessToken)
        if (alive) setTodayCount(Number(res?.today?.eventCount ?? 0))
      } catch { /* 조회 실패 시 이전 값 유지 */ }
    }
    load()
    const id = setInterval(load, 30_000)
    return () => { alive = false; clearInterval(id) }
  }, [enabled, accessToken])

  const simAlarms = (status.logs || []).filter((log: any) => log.kind === 'fire' || log.kind === 'heat').length
  const alarmValue = enabled ? todayCount : simAlarms
  const alarmTone: Tone = alarmValue == null ? 'none' : alarmValue > 0 ? 'bad' : 'none'

  // 로봇 단계. 표시 규칙 네 가지 —
  //  · 연결 안 됨            → 'OFF'
  //  · 연결됐지만 status 미수신 → '연결'. 🔴 'ON' 이라고 쓰면 "정상 운행 중"으로 읽힌다.
  //                              브리지만 붙고 스택은 아직인 구간이 실제로 존재한다
  //  · 아는 단계             → 짧은 라벨
  //  · 모르는 단계           → **원문 그대로**. 로봇이 표에 없는 값을 추가해도 화면이 깨지지
  //                              않는다(readiness.blockedBy 가 쓰는 것과 같은 방식이다)
  const rawStatus = enabled ? String(telemetry?.status || '') : ''
  const robotOnline = enabled ? (connected && rawStatus !== 'OFFLINE') : true
  const stage = STAGE[rawStatus]
  const stageValue = !robotOnline ? 'OFF'
    : stage ? stage.short
      : rawStatus ? rawStatus
        : (enabled ? '연결' : 'ON')
  const stageNote = !robotOnline ? '로봇과 연결되지 않았다'
    : stage ? stage.full
      : rawStatus ? `알 수 없는 단계: ${rawStatus}`
        : (enabled ? '연결됨 — 아직 단계 정보를 받지 못했다' : '시뮬레이션 동작 중')
  // 시뮬레이션은 종전대로 ok 를 유지한다(단계 값이 없으므로 표에서 못 찾는다).
  // 라이브에서 모르는 단계는 중립으로 둔다 — 모르는 것을 정상이라고 칠하지 않는다.
  const robotTone: Tone = !robotOnline ? 'bad'
    : stage ? stage.tone
      : (enabled ? 'none' : 'ok')

  return (
    <div className="kpis">
      {/* 배터리는 추세가 아니라 **잔량 게이지**다 — 값이 클수록 막대가 오른쪽으로 길어진다.
          스파크라인이던 시절에는 폭이 늘 꽉 차 있고 높이만 낮아서, 33% 인데도 "거의 다 찼다"로
          보였다 [사용자 지적 2026-08-09]. Gauge 주석에 이유를 자세히 적어 뒀다. */}
      <Kpi
        value={batt == null ? '—' : String(batt)} unit={batt == null ? undefined : '%'}
        label="배터리" tone={battTone} gauge={batt ?? null}
      />
      {/* 🔴 스파크라인을 뗐다 [사용자 지시 2026-08-09] — 숫자만 있으면 된다.
          이 값이 답해야 하는 질문은 "오늘 몇 건인가" 하나이고, 그건 숫자가 이미 답한다.
          게다가 추세는 화면이 열려 있는 동안 30초 폴링으로만 쌓여서, 방금 들어온 사람에게는
          막대가 한두 개뿐이고 오래 켜 둔 사람에게는 여덟 개다 — 같은 상황이 사람마다
          다르게 보이는 그림이었다. */}
      <Kpi
        value={alarmValue == null ? '—' : String(alarmValue)} unit={alarmValue == null ? undefined : '건'}
        label="경보 이벤트 (오늘)" tone={alarmTone}
      />
      {/* 단계를 보여 준다 — 종전에는 ON/OFF 뿐이라 부팅·매핑·저장·순찰이 모두 'ON' 이었다.
          전체 문장은 note(sr-only)로 보낸다: 타일은 큰 숫자용 슬롯이라 긴 문장이 들어가면 깨진다. */}
      <Kpi
        value={stageValue}
        label="로봇 상태" tone={robotTone} note={stageNote}
      />
    </div>
  )
}
