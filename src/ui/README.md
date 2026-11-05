# ilchon design kit (src/ui)

Web port of the Coconut Design System. Dark is the default theme; `<html data-theme="light">` switches to light.
Import everything from `'../ui'` (or `'./ui'`). Importing it also loads `tokens.css` and registers the kit's own strings (i18n namespace `ui`), so no CSS import is needed in `main.tsx`.
Wrap the app once in `<ToastProvider>`. Controls are 44px touch targets; text inputs are 16px (no iOS zoom).

## Tokens (CSS variables, `tokens.css`)
Colors: `--c-bg --c-surface --c-surface-2 --c-sheet --c-border --c-border-strong --c-text --c-text-dim --c-text-faint --c-primary --c-on-primary --c-accent --c-accent-soft --c-danger --c-danger-text --c-danger-soft --c-success --c-success-soft --c-warning --c-warning-soft --c-info --c-info-soft`.
Radius: `--radius-xs 4, -sm 8, -badge 10, -md 12, -dialog 16, -lg 20, -xl 24, -sheet 32, -pill`.
Spacing: `--sp-2 -4 -6 -8 -12 -16 -20 -24 -28 -32 -40 -48 -64`. Font size: `--fs-10 -12 -14 -16 -18 -21 -28 -32`. Heights: `--h-sm 36, --h-md 44, --h-lg 52, --h-input 56`.
Safe area: `--safe-t --safe-r --safe-b --safe-l`. Layout: `--app-max-width 560px`, `--appbar-h 56px`, `--bottom-nav-h 60px`.
Utility classes: `.num` (SpaceGrotesk tabular numbers, use for amounts/rates/counts), `.t-h1 .t-h2 .t-h3 .t-h4 .t-body1 .t-body2 .t-body3 .t-caption`, `.t-bold .t-dim .t-accent .t-danger .t-truncate`, `.ui-page` (centered max-width column with 16px gutters), `.ui-has-nav` (bottom padding to clear BottomNav), `.ui-stack` (column, 12px gap), `.ui-row` (row, centered, 8px gap), `.ui-grow`, `.safe-t .safe-b .safe-x .safe-all`, `.sr-only`.
Helper: `cx(...classNames)` joins truthy class names.

## Components

**Button** `{ variant?: 'primary'|'secondary'|'ghost'|'danger' = 'primary'; size?: 'sm'|'md'|'lg' = 'md'; fullWidth?; loading?; leading?: ReactNode; children; ...all <button> attrs }` — `type` defaults to `"button"`. `loading` shows a spinner, keeps width, disables clicks. Heights 36/44/52.

**IconButton** `{ icon: ReactNode; label: string (required aria-label); variant?: 'ghost'|'filled'|'primary' = 'ghost'; size?: 'sm'|'md'|'lg' = 'md'; ...<button> attrs }`

**Segmented<T extends string>** `{ options: {value: T; label: ReactNode; disabled?}[]; value: T; onChange: (v: T) => void; fullWidth?: boolean = true; size?: 'md'|'sm' = 'md'; disabled?; ariaLabel? }` — sliding thumb, 2-4 options works best.

**TextField** `{ value: string; onChange: (v: string) => void; label?; placeholder?; inputMode?: 'numeric'|'decimal'|'text'|'tel'|'email'|'url'|'search'|'none'; type?; prefix?: ReactNode; suffix?: ReactNode; error?: string|false|null; helper?: ReactNode; disabled?; readOnly?; autoFocus?; autoComplete?; autoCapitalize?; spellCheck?; maxLength?; name?; id?; multiline?: boolean; rows?: number = 3; numeric?: boolean (number font); onBlur?; onFocus?; onEnter?: () => void; inputRef?: Ref<HTMLInputElement>; className? }` — `onChange` receives the string, not the event. `error` replaces `helper`.

**Chip** `{ children; selected?; onClick?; disabled?; icon?: ReactNode }` — with `onClick` it is a toggle button (`aria-pressed`), without it a static label. Selected = accent color + bold.

**Switch** `{ checked: boolean; onChange: (checked: boolean) => void; disabled?; label?: string (aria-label); id? }`

**Badge** `{ children; tone?: 'neutral'|'primary'|'success'|'warning'|'danger'|'info' = 'neutral'; icon?: ReactNode }`

**Card** `{ children; padding?: 'none'|'sm'|'md'|'lg' = 'md'; tone?: 'default'|'outline'|'primary' = 'default'; onClick?: () => void (renders a <button>); disabled?; className? }`

**ListRow** `{ title: ReactNode; subtitle?: ReactNode; leading?: ReactNode; trailing?: ReactNode; onClick?: () => void (whole row pressable); chevron?: boolean; divider?: boolean; disabled?; className? }` — min height 64, text truncates.

**Avatar** `{ seed: string; name?: string; size?: number = 40 }` — color derived deterministically from `seed` (Coconut palette); initial = first character of `name`, else of `seed`.

**Spinner** `{ size?: number = 24; tone?: 'accent'|'inherit'|'dim' = 'accent' }`

**EmptyState** `{ title: string; body?: ReactNode; icon?: ReactNode; action?: ReactNode }` — `body` honors `\n`.

**AppBar** `{ title?: ReactNode; left?: ReactNode; right?: ReactNode; onBack?: () => void (renders a back IconButton if `left` is not given); border?: boolean; sticky?: boolean = true }` — 56px, centered title, safe-area top.

**BottomNav<T extends string>** `{ items: {value: T; label: string; icon: ReactNode; badge?: boolean|number}[]; value: T; onChange: (v: T) => void; fixed?: boolean = true }` — fixed to the bottom, safe-area aware, 60px. Give scroll content the `.ui-has-nav` class.

**BottomSheet** `{ open: boolean; onClose: () => void; title?: ReactNode; children; footer?: ReactNode (sticky buttons area); dismissible?: boolean = true (backdrop tap + Escape close); hideClose?: boolean }` — portal, slide-up, max 95% height, body scrolls, locks page scroll.

**Dialog** `{ open: boolean; title?: string; children?: ReactNode (description); confirmLabel?: string; cancelLabel?: string; onConfirm: () => void; onCancel: () => void (cancel button, Escape, backdrop); tone?: 'default'|'danger'; hideCancel?: boolean }` — labels default to localized 확인/취소. Controlled: the caller closes it inside `onConfirm`/`onCancel`.

**ToastProvider / useToast()** `<ToastProvider>{app}</ToastProvider>`; `const toast = useToast(); toast.show(message: string, tone?: 'info'|'success'|'warning'|'error' = 'info', durationMs?: number); toast.clear()` — max 3 stacked, tap to dismiss, sits above BottomNav. Outside a provider `show` is a silent no-op.

**Icons** `IconPlus IconClose IconBack IconChevronRight IconCheck IconCopy IconTrash IconEdit IconInfo IconWarning IconLock IconSend IconUsers IconSettings IconQr IconScan IconSwap IconBoard`, each `{ size?: number = 24; strokeWidth?: number = 1.8; title?: string (accessible name; omit when decorative); ...<svg> attrs }`, colored by `currentColor`. Also `<Icon name="qr" />` (names: plus close back chevronRight check copy trash edit info warning lock send users settings qr scan swap board) and the `icons` map.

## Notes
- Fonts: `public/fonts` (Pretendard 400/700, SpaceGrotesk 400/500/700), loaded from `/fonts/...`.
- Dark theme is the default; nothing follows `prefers-color-scheme`. Set `document.documentElement.dataset.theme = 'light'` to switch.
- Motion honors `prefers-reduced-motion` globally.
