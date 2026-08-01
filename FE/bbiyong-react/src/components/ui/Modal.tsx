import { useEffect } from 'react'

// 공용 모달 (오버레이 + 카드). ESC/오버레이 클릭으로 닫힘.
/**
 * @param {{ title: string, onClose: () => void,
 *           children?: import('react').ReactNode, width?: number }} props
 */
export default function Modal({ title, onClose, children, width = 400 }: { title: string, onClose: () => void,
            children?: import('react').ReactNode, width?: number }) {
  useEffect(() => {
    const onKey = (e: any) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: width }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-x" aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}
