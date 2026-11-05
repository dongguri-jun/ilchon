import { cx } from './cx'
import './Avatar.css'

export interface AvatarProps {
  /** Any stable string (pubkey, id). Same seed -> same color. */
  seed: string
  /** Display name; its first character is the initial. Falls back to seed. */
  name?: string
  /** Pixel size, default 40. */
  size?: number
  className?: string
}

function hash(s: string): number {
  // FNV-1a
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function initialOf(s: string): string {
  const t = s.trim()
  if (!t) return '?'
  // First user-perceived character (handles Hangul and emoji).
  const first = Array.from(t)[0]
  return first.toUpperCase()
}

/** Round avatar: tinted Coconut palette color derived from the seed + an initial letter. */
export function Avatar({ seed, name, size = 40, className }: AvatarProps) {
  const i = hash(seed) % 10
  return (
    <span
      className={cx('ui-avatar', className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: `var(--c-pal-bg-${i})`,
        color: `var(--c-pal-${i})`,
      }}
      aria-hidden
    >
      {initialOf(name?.trim() ? name : seed)}
    </span>
  )
}
