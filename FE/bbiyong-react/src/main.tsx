import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './styles/app.css'
import './styles/navexa.css'

// 로그인 화면·모달이 로그인 전에도 일관된 테마를 갖도록 기본값 설정
document.documentElement.setAttribute('data-theme', localStorage.getItem('theme') || 'light')

createRoot(document.getElementById('root')!).render(<App />)
