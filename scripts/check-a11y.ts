/**
 * Accessibility checks that need no browser (axe-core 4.14 and Lighthouse 13.6 run on a
 * phone, 2026-11-14; goal WCAG 2.1 AA). No network.
 *
 *  A0  the contrast formula gives the known values (#777777 on white 4.48, black on white 21)
 *  A1  text tokens in src/ui/tokens.css reach 4.5:1 on every surface they are used on:
 *      --c-text-dim and --c-accent on the neutral surfaces and on --c-accent-soft over the
 *      page; --c-text-faint and --c-seg-text on the neutral surfaces. The order stays
 *      body darker than dim, dim darker than faint, and dim stays visibly darker than faint
 *      (their contrast with each other at least DIM_FAINT_MIN: #5c5c5c and #6b6b6b
 *      were 1.25, too close to tell apart). The boot splash text (public/boot-splash.css)
 *      is --c-text-dim and reaches 4.5:1 on white.
 *  A2  language buttons: the accessible name starts with the visible code (label in name,
 *      WCAG 2.5.3) for every language, and DemoBanner uses that name.
 *  A3  landmarks: the setup, unlock and phone-gate screens put their content in <main>,
 *      the demo banner is a named region, the room and the connect screen are named dialogs
 *      without aria-modal (VoiceOver hides everything outside an aria-modal
 *      dialog, also the toast live region portalled to <body>; the tabs under them are
 *      inert), and AppBar renders no h1 without a title.
 *  A4  logo: every <img> of the ilchon logo (index.html, setup, unlock, phone gate, install
 *      guide, board, connection cover; and any other file of src/ that names a logo file)
 *      uses a PNG at most 200 KB, with width and height attributes that match the picture,
 *      and with at least twice the displayed pixels.
 *  A5  room stepper buttons (axe label-content-name-mismatch): the
 *      button shows the step number, so its accessible name (stepGo, stepGoChecked,
 *      stepGoCheckedOnchain) starts with that number as a whole word in every language
 *      ('3, …', not '3단계: …' or 'Step 3: …'), and RoomScreen still draws i + 1 and
 *      names the button with those keys.
 *  A6  --c-danger-text (axe color-contrast on the board's 내리기 button)
 *      reaches 4.5:1 on the neutral surfaces, on the lime cards (--c-primary-soft over the
 *      page, the own-offer card ui-card--primary; --c-primary, my chat bubble), and on
 *      --c-danger-soft over each of those (badges, warnings, the blocking invoice line).
 *  A7  room guide prev/next buttons: the guide body scrolls (max-height 40% on
 *      .room__summary), so .room__step-nav is position: sticky; bottom: 0 with a solid
 *      background and sits inside .room__guide-body, after the invoice-expired note. Else
 *      one more note line pushes the buttons half out of sight (217 of 272 px at 375x812).
 *  A8  reduced motion: the global prefers-reduced-motion rule in tokens.css forces
 *      one 0.01ms iteration on every element, which froze the spinner as a still ring. Spinner.css
 *      has its own reduce rule that, with !important longhands, keeps a slow non-rotating
 *      infinite animation (a fade) that defined keyframes back.
 *
 * Run: pnpm check:a11y
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { LANGS } from '../src/contracts'
import { langButtonLabel, langShort } from '../src/i18n/lang'
import { listDictionaries } from '../src/i18n'
import { ROOM_NS } from '../src/screens/room/strings'

/** The least contrast between --c-text-dim and --c-text-faint, so the two greys stay a visible hierarchy. */
const DIM_FAINT_MIN = 1.5

let failed = 0
function check(id: string, problems: string[], ok: string) {
  if (problems.length) {
    failed++
    console.log(`FAIL  ${id}  ${problems.join('\n        ')}`)
  } else console.log(`PASS  ${id}  ${ok}`)
}

type Rgb = [number, number, number]
function hex(h: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(h.trim())
  if (!m) throw new Error(`not a #rrggbb colour: ${h}`)
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as Rgb
}
function rgba(v: string): { rgb: Rgb; a: number } {
  const m = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(v.trim())
  if (m) return { rgb: [+m[1], +m[2], +m[3]], a: +m[4] }
  return { rgb: hex(v), a: 1 }
}
function over(top: string, base: Rgb): Rgb {
  const { rgb, a } = rgba(top)
  return rgb.map((c, i) => Math.round(c * a + base[i] * (1 - a))) as Rgb
}
function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function ratio(a: Rgb, b: Rgb): number {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
const show = (c: Rgb) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')

// ---------- A0 ----------
{
  const p: string[] = []
  const r1 = ratio(hex('#777777'), hex('#ffffff'))
  if (Math.abs(r1 - 4.48) > 0.01) p.push(`#777777 on white gave ${r1.toFixed(3)}, expected 4.48`)
  const r2 = ratio(hex('#000000'), hex('#ffffff'))
  if (Math.abs(r2 - 21) > 1e-9) p.push(`black on white gave ${r2}`)
  const mixed = show(over('rgba(136, 193, 37, 0.16)', hex('#ffffff')))
  if (mixed !== '#ecf5dc') p.push(`accent-soft over white gave ${mixed}, axe measured #ecf5dc`)
  check('A0', p, 'contrast formula: #777777/white 4.48, black/white 21, accent-soft over white #ecf5dc')
}

// ---------- A1 ----------
{
  const css = readFileSync('src/ui/tokens.css', 'utf8')
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
  const token = (name: string): string => {
    const m = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(root)
    if (!m) throw new Error(`${name} not found in the first :root block of tokens.css`)
    return m[1].trim()
  }
  const p: string[] = []
  const notes: string[] = []
  const page = hex(token('--c-bg'))
  const neutrals: Record<string, Rgb> = {
    '--c-bg': page,
    '--c-sheet': hex(token('--c-sheet')),
    '--c-surface': hex(token('--c-surface')),
    '--c-surface-2': hex(token('--c-surface-2')),
    '--c-seg-bg': hex(token('--c-seg-bg')),
  }
  const withSoft: Record<string, Rgb> = { ...neutrals, '--c-accent-soft/--c-bg': over(token('--c-accent-soft'), page) }
  const pairs: [string, Record<string, Rgb>][] = [
    ['--c-text-dim', withSoft],
    ['--c-accent', withSoft],
    ['--c-text-faint', neutrals],
    ['--c-seg-text', neutrals],
  ]
  for (const [fg, bgs] of pairs) {
    const c = hex(token(fg))
    let min = Infinity
    for (const [bgName, bg] of Object.entries(bgs)) {
      const r = ratio(c, bg)
      min = Math.min(min, r)
      if (r < 4.5) p.push(`${fg} ${show(c)} on ${bgName} ${show(bg)} is ${r.toFixed(2)}:1, below 4.5`)
    }
    notes.push(`${fg} ${show(c)} ≥ ${min.toFixed(2)}`)
  }
  const body = luminance(hex(token('--c-text')))
  const dim = luminance(hex(token('--c-text-dim')))
  const faint = luminance(hex(token('--c-text-faint')))
  if (!(body < dim && dim < faint)) p.push('the greys lost their order: --c-text darker than --c-text-dim darker than --c-text-faint')
  const gap = ratio(hex(token('--c-text-dim')), hex(token('--c-text-faint')))
  if (gap < DIM_FAINT_MIN) p.push(`--c-text-dim and --c-text-faint are too close to tell apart: ${gap.toFixed(2)}:1, below ${DIM_FAINT_MIN}`)
  notes.push(`dim/faint ${gap.toFixed(2)}`)
  const splash = /\.boot-splash\s*\{[^}]*?\bcolor:\s*(#[0-9a-f]{6})/i.exec(readFileSync('public/boot-splash.css', 'utf8'))?.[1]
  if (!splash) p.push('public/boot-splash.css: no .boot-splash text colour found')
  else {
    if (ratio(hex(splash), hex('#ffffff')) < 4.5) p.push(`boot splash text ${splash} on white is below 4.5`)
    if (splash.toLowerCase() !== token('--c-text-dim').toLowerCase()) p.push(`boot splash text ${splash} is not --c-text-dim ${token('--c-text-dim')}`)
  }
  check('A1', p, notes.join(', ') + '; splash text is --c-text-dim, on white ok')
}

// ---------- A6 ----------
{
  const css = readFileSync('src/ui/tokens.css', 'utf8')
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
  const token = (name: string): string => {
    const m = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(root)
    if (!m) throw new Error(`${name} not found in the first :root block of tokens.css`)
    return m[1].trim()
  }
  const p: string[] = []
  const page = hex(token('--c-bg'))
  const bases: Record<string, Rgb> = {
    '--c-bg': page,
    '--c-sheet': hex(token('--c-sheet')),
    '--c-surface': hex(token('--c-surface')),
    '--c-surface-2': hex(token('--c-surface-2')),
    '--c-primary-soft/--c-bg (lime card)': over(token('--c-primary-soft'), page),
    '--c-primary (lime)': hex(token('--c-primary')),
  }
  const bgs: Record<string, Rgb> = { ...bases }
  for (const [name, base] of Object.entries(bases)) bgs[`--c-danger-soft/${name}`] = over(token('--c-danger-soft'), base)
  const fg = hex(token('--c-danger-text'))
  let min = Infinity
  for (const [bgName, bg] of Object.entries(bgs)) {
    const r = ratio(fg, bg)
    min = Math.min(min, r)
    if (r < 4.5) p.push(`--c-danger-text ${show(fg)} on ${bgName} ${show(bg)} is ${r.toFixed(2)}:1, below 4.5`)
  }
  // The board's 내리기 button is a ghost button in danger text on the lime own-offer card.
  const board = readFileSync('src/screens/board/board.css', 'utf8')
  if (!/\.board-mine__withdraw[^{]*\{[^}]*color:\s*var\(--c-danger-text\)/.test(board)) p.push('board.css: .board-mine__withdraw no longer uses --c-danger-text; check its colour on the lime card')
  check('A6', p, `--c-danger-text ${show(fg)} ≥ ${min.toFixed(2)} on ${Object.keys(bgs).length} backgrounds (lime card ${ratio(fg, bgs['--c-primary-soft/--c-bg (lime card)']).toFixed(2)})`)
}

// ---------- A2 ----------
{
  const p: string[] = []
  for (const l of LANGS) {
    const name = langButtonLabel(l)
    if (!name.startsWith(langShort(l))) p.push(`${l}: name '${name}' does not start with the visible '${langShort(l)}'`)
  }
  const banner = readFileSync('src/screens/shell/DemoBanner.tsx', 'utf8')
  const labels = [...banner.matchAll(/aria-label=\{([^}]+)\}/g)].map((m) => m[1].trim())
  const buttonLabels = labels.filter((s) => s !== 'LANG_GROUP_LABEL')
  if (buttonLabels.length !== 1 || buttonLabels[0] !== 'langButtonLabel(value)') p.push(`DemoBanner language buttons: aria-label is ${JSON.stringify(buttonLabels)}, expected langButtonLabel(value)`)
  if (!banner.includes('{langShort(value)}')) p.push('DemoBanner: the button text is no longer langShort(value)')
  check('A2', p, `language button names start with their code (${LANGS.map(langButtonLabel).join(', ')})`)
}

// ---------- A3 ----------
{
  const p: string[] = []
  for (const f of ['src/screens/lock/SetupScreen.tsx', 'src/screens/lock/UnlockScreen.tsx', 'src/screens/shell/PhoneGate.tsx']) {
    const s = readFileSync(f, 'utf8')
    const opens = (s.match(/<main\b/g) ?? []).length
    const closes = (s.match(/<\/main>/g) ?? []).length
    if (opens !== 1 || closes !== 1) p.push(`${f}: expected one <main>…</main>, found ${opens} and ${closes}`)
  }
  const banner = readFileSync('src/screens/shell/DemoBanner.tsx', 'utf8')
  if (!/<section className="shell-banner" aria-labelledby=\{/.test(banner)) p.push('DemoBanner is not a named <section>')
  const room = readFileSync('src/screens/room/RoomScreen.tsx', 'utf8')
  if (!/<div className="room" role="dialog" aria-label=\{name\}>/.test(room)) p.push('RoomScreen root is not a named dialog without aria-modal')
  const connect = readFileSync('src/screens/connect/ConnectScreen.tsx', 'utf8')
  if (!/<div className="connect" role="dialog" aria-label=\{t\('title'\)\}>/.test(connect)) p.push('ConnectScreen root is not a named dialog without aria-modal')
  for (const [f, src] of [
    ['RoomScreen', room],
    ['ConnectScreen', connect],
  ] as const) {
    if (/aria-modal=/.test(src)) p.push(`${f}: aria-modal hides the toast live region from VoiceOver`)
  }
  const bar = readFileSync('src/ui/AppBar.tsx', 'utf8')
  if (!/title == null \|\| title === '' \?/.test(bar)) p.push('AppBar: the h1 is no longer skipped when there is no title')
  check('A3', p, 'main on setup, unlock and phone gate; named banner region; room and connect named dialogs, not aria-modal; no empty AppBar h1')
}

// ---------- A4 ----------
{
  const p: string[] = []
  const pngSize = (path: string): [number, number] => {
    const b = readFileSync(path)
    if (b.toString('ascii', 12, 16) !== 'IHDR') throw new Error(`${path} is not a PNG`)
    return [b.readUInt32BE(16), b.readUInt32BE(20)]
  }
  const sites = [
    'index.html',
    'src/screens/lock/SetupScreen.tsx',
    'src/screens/lock/UnlockScreen.tsx',
    'src/screens/shell/PhoneGate.tsx',
    'src/screens/shell/InstallGuide.tsx',
    'src/screens/board/BoardScreen.tsx',
    'src/screens/shell/ConnectionScreen.tsx',
  ]
  // Any other file that names a logo file must be on the list too.
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]))
  for (const f of walk('src').filter((f) => /\.(tsx?|css)$/.test(f))) {
    if (/\/brand\/ilchon-logo/.test(readFileSync(f, 'utf8')) && !sites.includes(f)) p.push(`${f} names a logo file but is not checked here`)
  }
  const attr = (tag: string, name: string): string | undefined =>
    new RegExp(`\\b${name}=(?:"([^"]*)"|\\{(\\d+)\\})`)
      .exec(tag)
      ?.slice(1)
      .find((x) => x !== undefined)
  let imgs = 0
  for (const file of sites) {
    const tags = [...readFileSync(file, 'utf8').matchAll(/<img\b[^>]*>/g)].map((m) => m[0]).filter((t) => /\/brand\/ilchon-logo/.test(t))
    if (!tags.length) {
      p.push(`${file}: no logo <img>`)
      continue
    }
    for (const tag of tags) {
      imgs++
      const src = attr(tag, 'src')
      const w = attr(tag, 'width')
      const h = attr(tag, 'height')
      if (!src || !w || !h || attr(tag, 'alt') !== 'ilchon') {
        p.push(`${file}: a logo <img> without src, alt="ilchon", width and height: ${tag.slice(0, 120)}`)
        continue
      }
      const path = 'public' + src
      const bytes = statSync(path).size
      const [pw, ph] = pngSize(path)
      if (bytes > 200_000) p.push(`${file}: ${src} is ${bytes} bytes, more than 200 KB`)
      if (pw < 2 * +w || ph < 2 * +h) p.push(`${file}: ${src} is ${pw}x${ph}, less than twice ${w}x${h}`)
      if (Math.abs(pw / ph - +w / +h) > 0.05) p.push(`${file}: width/height ${w}x${h} do not match the picture ${pw}x${ph}`)
    }
  }
  check('A4', p, `${imgs} logo images in ${sites.length} files: small PNG, width and height set, 2x pixels`)
}

// ---------- A5 ----------
{
  const p: string[] = []
  const room = listDictionaries().get(ROOM_NS)
  const keys = ['stepGo', 'stepGoChecked', 'stepGoCheckedOnchain']
  const shown: string[] = []
  if (!room) p.push(`string table '${ROOM_NS}' is not registered`)
  else
    for (const lang of LANGS) {
      const dict = room[lang]
      for (const key of keys) {
        const value = dict?.[key]
        if (value === undefined) {
          if (lang !== 'ja') p.push(`${lang}.${key} missing`)
          continue
        }
        const name = value.replace('{n}', '3').replace('{title}', 'X')
        // The visible '3' must be a whole word at the start: a digit, then no letter or digit.
        if (!/^3(?![\p{L}\p{N}])/u.test(name)) p.push(`${lang}.${key}: name '${name}' does not start with the visible '3' as a word`)
        if (key === 'stepGo') shown.push(`${lang} '${name}'`)
      }
    }
  const screen = readFileSync('src/screens/room/RoomScreen.tsx', 'utf8')
  if (!/className="room__stepper-btn"[\s\S]{0,200}aria-label=\{t\(s\.checked \? words\.stepGoChecked : 'stepGo', \{ n: i \+ 1,/.test(screen))
    p.push('RoomScreen: the stepper button is no longer named with stepGo / words.stepGoChecked and n: i + 1')
  if (!screen.includes(': i + 1}')) p.push('RoomScreen: the stepper button no longer shows i + 1')
  check('A5', p, `room stepper names start with the shown number (${shown.join(', ')})`)
}

// ---------- A7 ----------
{
  const p: string[] = []
  const css = readFileSync('src/screens/room/RoomScreen.css', 'utf8')
  const rule = (sel: string) => new RegExp(`^${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? ''
  const nav = rule('.room__step-nav')
  if (!/position:\s*sticky/.test(nav)) p.push('.room__step-nav is not position: sticky')
  if (!/bottom:\s*0\b/.test(nav)) p.push('.room__step-nav does not stick to bottom: 0')
  if (!/background:\s*var\(--c-surface\)/.test(nav)) p.push('.room__step-nav has no solid background (text would show through)')
  if (!/overflow-y:\s*auto/.test(rule('.room__guide-body'))) p.push('.room__guide-body no longer scrolls (overflow-y: auto)')
  const screen = readFileSync('src/screens/room/RoomScreen.tsx', 'utf8')
  const body = /className="room__guide-body">([\s\S]*?)<\/Card>/.exec(screen)?.[1] ?? ''
  if (!body.includes('className="room__step-nav"')) p.push('RoomScreen: .room__step-nav is not inside .room__guide-body')
  if (!/scroll-padding-bottom/.test(css)) p.push('.room__guide-body has no scroll-padding-bottom (focus would hide under the nav)')
  if (!/manualChecks[\s\S]*room__step-nav/.test(body)) p.push('RoomScreen: manualChecks note must come before the sticky nav')
  check('A7', p, 'guide prev/next buttons are sticky at the bottom of the scrolling guide body')
}

// ---------- A8 ----------
{
  const p: string[] = []
  const css = readFileSync('src/ui/Spinner.css', 'utf8')
  const tokens = readFileSync('src/ui/tokens.css', 'utf8')
  const globalRule = /@media \(prefers-reduced-motion: reduce\) \{[^}]*animation-iteration-count: 1 !important/.test(tokens)
  const block = /@media \(prefers-reduced-motion: reduce\) \{\s*\.ui-spinner \{([^}]*)\}/.exec(css)?.[1]
  if (!block) p.push('Spinner.css has no prefers-reduced-motion rule for .ui-spinner')
  else {
    const decl = (name: string) => new RegExp(`(?:^|[\\s;])${name}:\\s*([^;!]+?)\\s*!important`).exec(block)?.[1]
    const name = decl('animation-name')
    const dur = decl('animation-duration')
    if (decl('animation-iteration-count') !== 'infinite') p.push('reduced motion: animation-iteration-count is not infinite !important')
    if (!name) p.push('reduced motion: animation-name !important is missing')
    else {
      if (name === 'ui-spin') p.push('reduced motion: the spinner still rotates (ui-spin)')
      const kf = new RegExp(`@keyframes ${name}\\b([^@]*)`).exec(css)?.[1] ?? ''
      if (!kf) p.push(`reduced motion: @keyframes ${name} is not defined`)
      else if (/rotate|translate|scale/.test(kf)) p.push(`reduced motion: @keyframes ${name} moves the spinner`)
    }
    if (!dur || parseFloat(dur) < 0.5) p.push(`reduced motion: animation-duration ${dur ?? 'missing'} !important is not slow (at least 0.5s)`)
  }
  if (!globalRule) p.push('tokens.css: the global reduced-motion rule changed; re-check the spinner override')
  check('A8', p, 'under reduced motion the spinner keeps a slow infinite fade, with !important beating the global one-shot rule')
}

if (failed) {
  console.log(`\n${failed} FAILED`)
  process.exit(1)
}
console.log('\nALL PASS')
