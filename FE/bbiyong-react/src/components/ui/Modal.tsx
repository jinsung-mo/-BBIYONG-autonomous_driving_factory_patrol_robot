import { useEffect } from 'react'
import { createPortal } from 'react-dom'

// 공용 모달 (오버레이 + 카드). ESC/오버레이 클릭으로 닫힘.
//
// body 로 옮겨 그린다(portal). 모달은 position:fixed 로 화면 전체를 덮어야 하는데,
// 조상 중에 backdrop-filter · transform · filter 를 가진 요소가 있으면 그 요소가
// fixed 의 포함 블록이 되어 inset:0 이 화면이 아니라 그 상자 기준이 된다.
// 실제로 유저 메뉴의 마이페이지 모달이 그랬다 — 시뮬 화면의 상단 바에 backdrop-filter 가
// 걸려 있어, 모달이 56px 짜리 바 안에 갇혀 대시보드 뒤로 사라졌다.
// 쌓임 맥락도 같은 이유로 갇힌다. 어디서 열리든 화면 기준으로 뜨게 하려면 body 가 맞다.
/**
 * @param {{ title: string, onClose: () => void,
 *           children?: import('react').ReactNode, width?: number, className?: string }} props
 */
export default function Modal({ title, onClose, children, width = 400, className = '' }: { title: string, onClose: () => void,
            children?: import('react').ReactNode, width?: number, className?: string }) {
  useEffect(() => {
    const onKey = (e: any) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      {/* 모달은 body 로 포털돼 화면의 v3-theme 조상 스코프 밖에서 그려진다 —
          화면별 스킨은 이 className 으로만 닿는다(S15P11E101-814). */}
      <div className={`modal${className ? ` ${className}` : ''}`} style={{ maxWidth: width }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-x" aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
