import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
// 디자인 시스템 v3 토큰(--bb-*)이 먼저 와야 한다 — app.css 의 .welcome-* 규칙이 이 값을 참조한다.
import './styles/tokens.css'
import './styles/app.css'
import './styles/navexa.css'

// 로그인 화면·모달이 로그인 전에도 일관된 테마를 갖도록 기본값 설정
document.documentElement.setAttribute('data-theme', localStorage.getItem('theme') || 'light')

createRoot(document.getElementById('root')!).render(<App />)
