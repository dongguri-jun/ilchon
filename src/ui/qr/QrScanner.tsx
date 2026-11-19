import { useEffect, useRef, useState } from 'react'
import Scanner from 'qr-scanner'
import './qr.css'
import { cameraContext, cameraReason, type CameraReason } from './camera-reason'

export interface QrScannerProps {
  active: boolean
  /** Called once per distinct decoded text while the scanner stays active. */
  onResult: (text: string) => void
  /** Called with a short reason (camera-reason.ts CameraReason) when the camera cannot be used. */
  onError: (reason: CameraReason) => void
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

    // Every branch returns this cleanup: fail() awaits the browser (cameraContext), so a
    // scanner switched off or unmounted meanwhile must not report.
    let scanner: Scanner | null = null
    const cleanup = () => {
      disposed = true
      // stop() releases the stream; destroy() also covers a start() still pending.
      scanner?.stop()
      scanner?.destroy()
    }

    const fail = (err: unknown) => {
      if (disposed) return
      setFailed(true)
      // The reason needs the browser's permission state and device list (camera-reason.ts).
      void cameraContext().then((ctx) => {
        if (!disposed) onErrorRef.current(cameraReason(err, ctx))
      })
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      fail(null)
      return cleanup
    }

    scanner = new Scanner(
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

    return cleanup
  }, [active])

  return (
    <div className={'qr-scanner' + (active && !failed ? ' qr-scanner--live' : '')}>
      <video ref={videoRef} className="qr-scanner__video" playsInline muted autoPlay />
      {active && !failed ? <div className="qr-scanner__frame" aria-hidden="true" /> : null}
    </div>
  )
}
