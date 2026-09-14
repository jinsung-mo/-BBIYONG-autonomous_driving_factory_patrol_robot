import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
// 디자인 시스템 v3 토큰(--bb-*)이 먼저 와야 한다 — app.css 의 .welcome-* 규칙이 이 값을 참조한다.
import './styles/tokens.css'
import './styles/app.css'
import './styles/navexa.css'

// 다크 모드는 걷어냈지만(S15P11E101-805) 이 속성은 상수로 계속 붙인다.
// app.css 의 라이트 대비 보정 규칙 190여 줄이 `:root[data-theme="light"] …` 로 잡혀 있어,
// 속성을 떼면 그 규칙들이 전부 매칭에 실패한다 — 상단바가 어두워지고 대비가 무너진다.
// 저장된 값은 더 이상 읽지 않는다. 첫 페인트 전에 붙어야 하므로 React 밖에서 설정한다.
document.documentElement.setAttribute('data-theme', 'light')

createRoot(document.getElementById('root')!).render(<App />)
