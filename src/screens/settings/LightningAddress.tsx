import { useState } from 'react'
import { actions, useIlchon } from '../../engine/browser'
import { useT } from '../../i18n'
import { parseLnAddress } from '../../lib/lnurl'
import { BottomSheet, Button, Card, Dialog, ListRow, TextField, useToast } from '../../ui'

/** The domain of a normalised `user@domain`. */
function domainOf(address: string | null): string | null {
  return address ? address.slice(address.lastIndexOf('@') + 1) : null
}

/**
 * Settings → Receiving → Lightning address. Saving asks the wallet service once
 * (setLightningAddress); before the first request to a domain the user has not confirmed
 * yet, a dialog shows that domain large and says what it sees: a new
 * address on the same domain needs no second confirmation.
 */
export function LightningAddressSetting() {
  const t = useT('settings')
  const toast = useToast()
  const current = useIlchon((s) => s.settings.lnAddress)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  /** A string key, not text: a language switch while it shows switches it too. */
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** The normalised address waiting for the domain confirmation. */
  const [confirm, setConfirm] = useState<string | null>(null)

  function openSheet() {
    setText(current ?? '')
    setError(null)
    setOpen(true)
  }

  async function save(address: string) {
    setConfirm(null)
    setBusy(true)
    setError(null)
    try {
      await actions.setLightningAddress(address)
      toast.show(t('lnSaved'), 'success')
      setOpen(false)
    } catch (e) {
      const code = e instanceof Error ? e.message : ''
      setError(code === 'bad-address' ? 'lnErrBadAddress' : code === 'unreachable' ? 'lnErrUnreachable' : code === 'save-failed' ? 'lnErrSave' : 'lnErrRefused')
    } finally {
      setBusy(false)
    }
  }

  function trySave() {
    if (busy) return
    // Checked here first, so a typo asks nobody (the engine checks again).
    const norm = parseLnAddress(text)
    if (!norm) {
      setError('lnErrBadAddress')
      return
    }
    if (norm === current) {
      setOpen(false)
      return
    }
    if (domainOf(norm) !== domainOf(current)) setConfirm(norm)
    else void save(norm)
  }

  async function remove() {
    setBusy(true)
    try {
      await actions.setLightningAddress(null)
      toast.show(t('lnRemoved'), 'success')
      setOpen(false)
    } catch {
      setError('lnErrSave')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Card padding="none">
        <ListRow title={t('lnTitle')} subtitle={<span className="settings__ln-value">{current ?? t('lnNone')}</span>} chevron onClick={openSheet} />
      </Card>

      <BottomSheet
        open={open}
        onClose={() => !busy && setOpen(false)}
        dismissible={!busy}
        title={t('lnTitle')}
        footer={
          <div className="ui-stack">
            <Button fullWidth size="lg" loading={busy} onClick={trySave}>
              {t('lnSave')}
            </Button>
            {current && (
              <Button fullWidth variant="ghost" disabled={busy} onClick={() => void remove()}>
                {t('lnRemove')}
              </Button>
            )}
          </div>
        }
      >
        <div className="ui-stack">
          <TextField
            label={t('lnTitle')}
            value={text}
            onChange={(v) => {
              setText(v)
              setError(null)
            }}
            placeholder="name@wallet.example"
            inputMode="email"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={320}
            disabled={busy}
            error={error ? t(error) : null}
            helper={t('lnHelper')}
            onEnter={trySave}
          />
          {busy && (
            <p className="t-caption t-dim" role="status">
              {t('lnChecking')}
            </p>
          )}
        </div>
      </BottomSheet>

      <Dialog open={confirm !== null} title={t('lnConfirmTitle')} confirmLabel={t('lnConfirmOk')} onConfirm={() => confirm && void save(confirm)} onCancel={() => setConfirm(null)}>
        <p className="settings__ln-domain num">{domainOf(confirm)}</p>
        <p>{t('lnConfirmBody')}</p>
      </Dialog>
    </>
  )
}
