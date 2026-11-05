import type { ReactNode, SVGProps } from 'react'

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children' | 'width' | 'height'> {
  /** Pixel size, default 24. */
  size?: number
  strokeWidth?: number
  /** Accessible name. Omit for decorative icons (aria-hidden). */
  title?: string
}

function make(name: string, body: ReactNode) {
  function Icon({ size = 24, strokeWidth = 1.8, title, style, ...rest }: IconProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        role={title ? 'img' : undefined}
        aria-hidden={title ? undefined : true}
        aria-label={title}
        focusable="false"
        {...rest}
        style={{ flex: 'none', ...style }}
      >
        {body}
      </svg>
    )
  }
  Icon.displayName = name
  return Icon
}

export const IconPlus = make('IconPlus', <path d="M5 12h14M12 5v14" />)
export const IconClose = make('IconClose', <path d="M18 6 6 18M6 6l12 12" />)
export const IconBack = make('IconBack', <path d="M19 12H5m7 7-7-7 7-7" />)
export const IconChevronRight = make('IconChevronRight', <path d="m9 18 6-6-6-6" />)
export const IconCheck = make('IconCheck', <path d="M20 6 9 17l-5-5" />)
export const IconCopy = make(
  'IconCopy',
  <>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </>,
)
export const IconTrash = make(
  'IconTrash',
  <>
    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M10 11v6M14 11v6" />
  </>,
)
export const IconEdit = make('IconEdit', <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />)
export const IconInfo = make(
  'IconInfo',
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4M12 8h.01" />
  </>,
)
export const IconWarning = make(
  'IconWarning',
  <>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <path d="M12 9v4M12 17h.01" />
  </>,
)
export const IconLock = make(
  'IconLock',
  <>
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </>,
)
export const IconSend = make('IconSend', <path d="m22 2-7 20-4-9-9-4ZM22 2 11 13" />)
export const IconUsers = make(
  'IconUsers',
  <>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </>,
)
export const IconSettings = make(
  'IconSettings',
  <>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
    <circle cx="12" cy="12" r="3" />
  </>,
)
export const IconQr = make(
  'IconQr',
  <>
    <rect x="3" y="3" width="5" height="5" rx="1" />
    <rect x="16" y="3" width="5" height="5" rx="1" />
    <rect x="3" y="16" width="5" height="5" rx="1" />
    <path d="M21 16h-3a2 2 0 0 0-2 2v3M21 21v.01M12 7v3a2 2 0 0 1-2 2H7M3 12h.01M12 3h.01M12 16v.01M16 12h1M21 12v.01M12 21v-1" />
  </>,
)
export const IconScan = make(
  'IconScan',
  <>
    <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
    <path d="M7 12h10" />
  </>,
)
/** Two opposing arrows: the trade / swap tab. */
export const IconSwap = make('IconSwap', <path d="m8 3-4 4 4 4M4 7h16M16 21l4-4-4-4M20 17H4" />)
/** Tiled board layout. */
export const IconBoard = make(
  'IconBoard',
  <>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </>,
)

export const icons = {
  plus: IconPlus,
  close: IconClose,
  back: IconBack,
  chevronRight: IconChevronRight,
  check: IconCheck,
  copy: IconCopy,
  trash: IconTrash,
  edit: IconEdit,
  info: IconInfo,
  warning: IconWarning,
  lock: IconLock,
  send: IconSend,
  users: IconUsers,
  settings: IconSettings,
  qr: IconQr,
  scan: IconScan,
  swap: IconSwap,
  board: IconBoard,
} as const

export type IconName = keyof typeof icons

/** Generic icon by name: <Icon name="qr" size={20} />. */
export function Icon({ name, ...rest }: IconProps & { name: IconName }) {
  const C = icons[name]
  return <C {...rest} />
}
