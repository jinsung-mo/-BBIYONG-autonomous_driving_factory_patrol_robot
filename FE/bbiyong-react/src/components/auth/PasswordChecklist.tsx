import { passwordChecks } from '../../auth/signupRules.ts'

// 비밀번호 정책 실시간 체크리스트 (S15P11E101).
// 타이핑하는 동안 각 조건(8자·영문·숫자·특수문자)의 충족 여부를 즉시 보여 준다 —
// 제출해야 무엇이 틀렸는지 알던 방식을 대체한다. 규칙은 signupRules.passwordChecks 한곳에서 온다.
export default function PasswordChecklist({ password }: { password: string }) {
  if (!password) return null
  return (
    <ul className="pw-checks" aria-label="비밀번호 조건">
      {passwordChecks(password).map((c) => (
        <li key={c.label} className={c.ok ? 'ok' : 'miss'}>
          <span aria-hidden="true">{c.ok ? '✓' : '·'}</span> {c.label}
        </li>
      ))}
    </ul>
  )
}
