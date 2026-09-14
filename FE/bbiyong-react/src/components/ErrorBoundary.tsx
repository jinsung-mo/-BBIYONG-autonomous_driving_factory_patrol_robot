import { Component, Fragment } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

// 렌더 예외 격리 (S15P11E101-897).
//
// React 는 렌더 중 예외를 잡아 줄 경계가 하나도 없으면 **루트를 통째로 언마운트한다** —
// 화면이 하얗게 되고 복구는 새로고침뿐이다. 2026-08-09 에 실제로 그 일이 있었다:
// ThreeMapView 안의 TypeError 하나가 관제 화면 전체를 지웠다(S15P11E101-896).
// 그 버그는 고쳤지만 다음 예외가 같은 일을 또 벌인다 — 그래서 버그가 아니라 구조를 막는다.
//
// 원칙: **한 구역이 죽어도 나머지 화면은 살아 있어야 한다.**
// 시연 중 지도가 안 보이는 것과 화면 전체가 백지가 되는 것은 완전히 다른 사고다.
//
// 대체 UI 는 새로 만들지 않고 지도 탭의 빈 상태(`.map-empty`) 마크업을 그대로 쓴다 —
// 같은 상황("여기에 보여 줄 것이 없다")을 이미 그 서식이 말하고 있다.
// 스택 트레이스는 화면에 내지 않는다. 조작자가 할 수 있는 일이 아니다 — 콘솔로 보낸다.
type Props = {
  /** 무엇이 안 보이는지. 그대로 "○○을 표시할 수 없습니다" 로 쓰인다. */
  what: string
  /** 조작자가 다음에 할 일. 생략하면 기본 안내를 쓴다. */
  hint?: string
  /**
   * 대체 UI 를 부모 영역에 겹쳐 채울지(기본) 자리를 차지하게 둘지.
   * `.map-empty` 는 `position:absolute; inset:0` 이라 **부모가 위치 기준(relative 등)일 때만**
   * 제자리에 뜬다. `.vwrap` 같은 위치 기준 안이면 기본값, 평범한 블록 안이면 `fill={false}`.
   */
  fill?: boolean
  children: ReactNode
}

// 받침이 있으면 '을', 없으면 '를'. what 이 호출부마다 달라서(지도 / 이벤트 로그 화면)
// 한쪽으로 고정하면 어느 한쪽이 반드시 어색해진다 — 한글 음절의 종성으로 고른다.
function objectParticle(word: string) {
  const last = word.trim().slice(-1).charCodeAt(0)
  if (Number.isNaN(last) || last < 0xac00 || last > 0xd7a3) return '를' // 한글 음절이 아니면 기본형
  return (last - 0xac00) % 28 === 0 ? '를' : '을'
}

type State = {
  failed: boolean
  /** '다시 시도' 마다 올린다. key 가 바뀌면 아래 나무가 통째로 새로 마운트된다. */
  attempt: number
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, attempt: 0 }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 원격 로깅 인프라는 없다 — 콘솔이 유일한 흔적이다. 어느 구역인지까지 남긴다.
    console.error(`[ErrorBoundary] ${this.props.what} 렌더 실패`, error, info.componentStack)
  }

  private retry = () => {
    // 상태만 되돌리면 같은 원소가 다시 그려질 뿐 내부 상태(WebGL 컨텍스트 등)는
    // 남는다. attempt 를 key 로 쓰므로 아래 나무는 새로고침 없이 새로 마운트된다.
    this.setState((prev) => ({ failed: false, attempt: prev.attempt + 1 }))
  }

  render() {
    if (this.state.failed) {
      const { what, hint, fill = true } = this.props
      return (
        <div className={`map-empty${fill ? '' : ' eb-inline'}`} role="alert">
          <b>{what}{objectParticle(what)} 표시할 수 없습니다</b>
          <span>{hint ?? '나머지 화면은 그대로 쓸 수 있습니다. 다시 시도를 누르면 이 영역만 다시 불러옵니다.'}</span>
          <button type="button" className="btn-ghost" onClick={this.retry}>다시 시도</button>
        </div>
      )
    }
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>
  }
}
