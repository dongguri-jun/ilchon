import { useMemo } from 'react'
import QRCode from 'qrcode'
import { useT } from '../../i18n'
import '../strings'
import './qr.css'

export interface QrCodeProps {
  text: string
  /** Outer tile edge in CSS pixels (quiet zone included). */
  size: number
}

/** Quiet zone in modules. The spec asks for 4; the white tile supplies it. */
const QUIET = 4

interface Matrix {
  count: number
  path: string
}

function buildMatrix(text: string): Matrix | null {
  try {
    const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' })
    const count = modules.size
    let path = ''
    for (let y = 0; y < count; y++) {
      let x = 0
      while (x < count) {
        if (!modules.get(x, y)) {
          x++
          continue
        }
        const start = x
        while (x < count && modules.get(x, y)) x++
        path += `M${start + QUIET} ${y + QUIET}h${x - start}v1h-${x - start}z`
      }
    }
    return { count, path }
  } catch {
    return null
  }
}

export function QrCode({ text, size }: QrCodeProps) {
  const t = useT('ui')
  const matrix = useMemo(() => buildMatrix(text), [text])
  const style = { width: size, height: size }

  if (!matrix) return <div className="qr-tile qr-tile--empty" style={style} aria-hidden="true" />

  const view = matrix.count + QUIET * 2
  return (
    <div className="qr-tile" style={style}>
      <svg
        viewBox={`0 0 ${view} ${view}`}
        width={size}
        height={size}
        shapeRendering="crispEdges"
        role="img"
        aria-label={t('qrCode')}
      >
        <rect width={view} height={view} fill="#fff" />
        <path d={matrix.path} fill="#000" />
      </svg>
    </div>
  )
}
