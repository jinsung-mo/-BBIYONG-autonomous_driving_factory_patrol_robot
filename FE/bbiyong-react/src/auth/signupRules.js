// 회원가입 입력 규칙 (S15P11E101-493).
// 컴포넌트에서 떼어내 규칙만 따로 둔다 — 검증 문구가 화면 코드에 흩어지면 바꾸기 어렵다.

export const GENDERS = [
  { value: 'MALE', label: '남성' },
  { value: 'FEMALE', label: '여성' },
  { value: 'UNSPECIFIED', label: '선택 안 함' },
]

// 입력 도중 자동으로 하이픈을 넣는다. 숫자 외 문자는 버린다.
export function formatPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '').slice(0, 11)
  if (d.length <= 3) return d
  if (d.length <= 7) return `${d.slice(0, 3)}-${d.slice(3)}`
  return `${d.slice(0, 3)}-${d.slice(3, d.length - 4)}-${d.slice(d.length - 4)}`
}

// 010-0000-0000 형태. 가운데 자리는 구형 번호(3자리)도 받는다.
const PHONE_RE = /^01[016789]-\d{3,4}-\d{4}$/

// 비밀번호 — 8자 이상 + 영문·숫자·특수문자 각 1자 이상.
// 무엇이 빠졌는지 그대로 알려주려고 항목별로 검사한다.
export function passwordProblems(pw) {
  const v = String(pw || '')
  const miss = []
  if (v.length < 8) miss.push('8자 이상')
  if (!/[A-Za-z]/.test(v)) miss.push('영문')
  if (!/\d/.test(v)) miss.push('숫자')
  if (!/[^A-Za-z0-9]/.test(v)) miss.push('특수문자')
  return miss
}

const MIN_BIRTH_YEAR = 1900

// 폼 전체 검증. 첫 번째로 걸린 문제 하나만 돌려준다(한 번에 하나씩 고치게).
export function validateSignup(form) {
  if (!form.name.trim()) return '이름을 입력하세요.'
  if (!form.email.trim()) return '이메일을 입력하세요.'

  // 조사(을/를·이/가)가 앞말 받침에 따라 달라져 어색해지므로 항목만 나열한다
  const miss = passwordProblems(form.password)
  if (miss.length) return `비밀번호 조건 미충족 — ${miss.join(' · ')}`
  if (form.password !== form.password2) return '비밀번호가 일치하지 않습니다.'

  if (!form.phone.trim()) return '휴대전화번호를 입력하세요.'
  if (!PHONE_RE.test(form.phone.trim())) return '휴대전화번호를 010-0000-0000 형식으로 입력하세요.'

  if (!form.birth) return '생년월일을 입력하세요.'
  const d = new Date(`${form.birth}T00:00:00`)
  if (Number.isNaN(d.getTime())) return '생년월일이 올바르지 않습니다.'
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  if (d > today) return '생년월일이 미래일 수 없습니다.'
  if (d.getFullYear() < MIN_BIRTH_YEAR) return `생년월일 연도를 ${MIN_BIRTH_YEAR}년 이후로 입력하세요.`

  if (!form.gender) return '성별을 선택하세요.'
  return null
}

// 오늘 날짜 — 생년월일 입력의 max 로 써서 미래 선택 자체를 막는다
export function todayISO() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export const MIN_BIRTH_ISO = `${MIN_BIRTH_YEAR}-01-01`
