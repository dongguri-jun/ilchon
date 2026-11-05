import { useEffect, useRef, useState } from 'react'
import Scanner from 'qr-scanner'
import './qr.css'

export interface QrScannerProps {
  active: boolean
  /** Called once per distinct decoded text while the scanner stays active. */
  onResult: (text: string) => void
  /** Called with a short reason when the camera cannot be used. */
  onError: (message: string) => void
}

function reasonOf(err: unknown): string {
  if (typeof window !== 'undefined' && !window.isSecureContext) return 'Camera needs https'
  const name = err instanceof Error ? err.name : ''
  const text = typeof err === 'string' ? err : err instanceof Error ? err.message : ''
  if (name === 'NotAllowedError' || name === 'SecurityError' || /permission|denied|not allowed/i.test(text)) {
    return 'Camera permission denied'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || /not found/i.test(text)) {
    return 'No camera found'
  }
  if (name === 'NotReadableError' || name === 'AbortError') return 'Camera is in use'
  return 'Camera unavailable'
}

export function QrScanner({ active, onResult, onError }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const onResultRef = useRef(onResult)
  const onErrorRef = useRef(onError)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    onResultRef.current = onResult
    onErrorRef.current = onError
  }, [onResult, onError])

  useEffect(() => {
    if (!active) return
    const video = videoRef.current
    if (!video) return

    setFailed(false)
    let disposed = false
    const seen = new Set<string>()

    const fail = (err: unknown) => {
      if (disposed) return
      setFailed(true)
      onErrorRef.current(reasonOf(err))
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      fail(null)
      return
    }

    const scanner = new Scanner(
      video,
      (result) => {
        if (disposed) return
        const text = result.data
        if (!text || seen.has(text)) return
        seen.add(text)
        onResultRef.current(text)
      },
      {
        preferredCamera: 'environment',
        returnDetailedScanResult: true,
        maxScansPerSecond: 8,
        highlightScanRegion: false,
        highlightCodeOutline: false,
        onDecodeError: () => {},
      },
    )

    scanner.start().catch(fail)

    return () => {
      disposed = true
      // stop() releases the stream; destroy() also covers a start() still pending.
      scanner.stop()
      scanner.destroy()
    }
  }, [active])

  return (
    <div className={'qr-scanner' + (active && !failed ? ' qr-scanner--live' : '')}>
      <video ref={videoRef} className="qr-scanner__video" playsInline muted autoPlay />
      {active && !failed ? <div className="qr-scanner__frame" aria-hidden="true" /> : null}
    </div>
  )
}
