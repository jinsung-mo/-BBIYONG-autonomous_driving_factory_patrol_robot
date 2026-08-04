// 검증 스크립트를 하나씩 순서대로 돌린다.
//
// 동시에 돌리지 않는 이유: 스크립트마다 가짜 백엔드를 8099 에 띄우므로 겹치면
// EADDRINUSE 로 죽는다. 느리더라도 순서대로 도는 편이 결과를 믿을 수 있다.
//
// 화면을 새로 그리기 전에 한 번 돌려 기준선을 잡아 두면, 무엇을 깨뜨렸는지 알 수 있다.
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// 기본은 '화면' 관련만. 전부 돌리려면 --all.
const SCREEN = [
  'check-liquidglass.mjs',
  'check-simskin.mjs',
  'check-dpad.mjs',
  'check-usermenu.mjs',
  'check-643.mjs',
  'check-653.mjs',
]
// 기본 목록에서 빼는 것들.
//  508      — 유휴 15초짜리 별도 인스턴스를 전제로 한다(README 참고).
//  camfull  — 아직 병합되지 않은 기능(카메라 확대)을 검사한다. 그 기능이 들어오면 넣는다.
const NEEDS_SPECIAL = new Set(['check-508.mjs', 'check-camfull.mjs'])

const all = process.argv.includes('--all')
const only = process.argv.filter((a) => a.startsWith('check-'))
const list = only.length ? only
  : all ? readdirSync(here).filter((f) => /^check-.*\.mjs$/.test(f) && !NEEDS_SPECIAL.has(f)).sort()
  : SCREEN

const run = (file) => new Promise((resolve) => {
  const p = spawn(process.execPath, [join(here, file)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', (d) => { out += d })
  p.stderr.on('data', (d) => { out += d })
  p.on('close', (code) => {
    const fails = (out.match(/\*\*FAIL\*\*/g) || []).length
    const passes = (out.match(/PASS/g) || []).length
    resolve({ file, fails, passes, code, out })
  })
})

console.log(`${list.length}개 스크립트를 순서대로 돌립니다. 가짜 백엔드가 8099 를 쓰므로`)
console.log('상주 인스턴스(serve-fake-backend)는 꺼 두세요.\n')

let bad = 0
for (const f of list) {
  process.stdout.write(`  ${f.padEnd(28)} … `)
  const r = await run(f)
  if (r.code !== 0 && r.passes === 0) {
    console.log('실행 실패')
    console.log(r.out.split('\n').slice(-6).map((l) => '      ' + l).join('\n'))
    bad++
  } else if (r.fails > 0) {
    console.log(`FAIL ${r.fails} / PASS ${r.passes}`)
    r.out.split('\n').filter((l) => l.includes('**FAIL**')).forEach((l) => console.log('      ' + l.trim()))
    bad++
  } else {
    console.log(`통과 (${r.passes})`)
  }
}

console.log(bad === 0 ? '\n전부 통과했습니다.' : `\n${bad}개 스크립트에서 실패가 있습니다.`)
process.exit(bad === 0 ? 0 : 1)
