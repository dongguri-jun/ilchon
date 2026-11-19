import { useT } from '../../i18n'
import { QrCode } from '../../ui/qr'
import { CopyLinkButton } from './CopyLinkButton'
import { DemoBanner } from './DemoBanner'
import './install-hint.css'
import './install-strings'

/** Stands in for the setup screen on a device that is not a phone (see device.ts). */
export function PhoneGate() {
  const t = useT('install')
  const url = window.location.origin
  return (
    <div className="shell">
      <DemoBanner />
      <main className="phone-gate">
        <div className="phone-gate__body">
          <img className="phone-gate__logo" src="/brand/ilchon-logo-860.png" alt="ilchon" width={153} height={36} />
          <h1 className="t-h3">{t('gateTitle')}</h1>
          <p className="t-body2 t-dim">{t('gateBody')}</p>
          <QrCode text={url} size={220} />
          <p className="install-url t-body2">{url}</p>
          <CopyLinkButton url={url} />
        </div>
      </main>
    </div>
  )
}
