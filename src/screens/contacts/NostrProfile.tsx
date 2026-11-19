import { useEffect, useRef, useState } from 'react'
import { memo } from '../../engine/browser'
import { useT } from '../../i18n'
import { Avatar, Button, TextField } from '../../ui'
import { fetchProfile, parseNpubOrHex, saveLinkedProfile, verifyNip05, type LinkedProfile } from '../../lib/nostr-profile'
import { NS } from './strings'

/** Result of the NIP-05 check the user asked for. Lives only while this section is open. */
type Nip05Check = { target: string; state: 'checking' | 'yes' | 'no' }

export function NostrProfileSection({ contactId, linked, onChange }: { contactId: string; linked: LinkedProfile | null; onChange: () => void }) {
  const t = useT(NS)
  const [input, setInput] = useState('')
  const [preview, setPreview] = useState<LinkedProfile | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [check, setCheck] = useState<Nip05Check | null>(null)
  const request = useRef(0)
  const checkRequest = useRef(0)
  useEffect(
    () => () => {
      request.current++
      checkRequest.current++
    },
    [],
  )
  const load = async () => {
    const id = ++request.current
    setPreview(null)
    setError('')
    const pubkey = parseNpubOrHex(input)
    if (!pubkey) {
      setError(t('nostrInvalid'))
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const profile = await fetchProfile(pubkey)
      if (request.current !== id) return
      if (!profile) {
        setError(t('nostrNotFound'))
        return
      }
      setPreview({ ...profile, pubkey })
    } catch {
      if (request.current === id) setError(t('nostrNotFound'))
    } finally {
      if (request.current === id) setLoading(false)
    }
  }
  const save = (profile: LinkedProfile | null) => {
    if (!saveLinkedProfile(memo, contactId, profile)) {
      setError(t('nostrStorageFailed'))
      return
    }
    setError('')
    setPreview(null)
    onChange()
  }
  const shown = preview || linked
  // The check belongs to one npub and one NIP-05 address; another profile shows no result.
  const checkTarget = shown?.nip05 ? `${shown.pubkey} ${shown.nip05}` : ''
  const checkShown = check && check.target === checkTarget ? check.state : null
  const runCheck = async () => {
    if (!shown?.nip05) return
    const id = ++checkRequest.current
    const target = checkTarget
    setCheck({ target, state: 'checking' })
    const ok = await verifyNip05(shown.nip05, shown.pubkey)
    if (checkRequest.current === id) setCheck({ target, state: ok ? 'yes' : 'no' })
  }
  return (
    <section className="contacts-nostr" aria-label={t('nostrTitle')}>
      <h3 className="t-body1 t-bold">{t('nostrTitle')}</h3>
      <p className="t-body3 t-dim">{t('nostrPrivacy')}</p>
      <p className="contacts-nostr__warning t-body3">{t('nostrWarning')}</p>
      <TextField
        label={t('nostrInput')}
        value={input}
        onChange={(value) => {
          request.current++
          setLoading(false)
          setInput(value)
          setPreview(null)
          setError('')
        }}
        placeholder="npub1… / nprofile1… / hex"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={5000}
        onEnter={load}
      />
      <Button variant="secondary" fullWidth loading={loading} disabled={!input.trim() || loading} onClick={load}>
        {t('nostrLoad')}
      </Button>
      {error && (
        <p className="contacts-nostr__error t-body3" role="alert">
          {error}
        </p>
      )}
      <div aria-live="polite" aria-busy={loading}>
        {shown && (
          <div className="contacts-nostr__preview">
            <Avatar seed={shown.pubkey} name={shown.display_name || shown.name} size={44} />
            <div className="contacts-nostr__details">
              <div className="t-body2 t-bold t-truncate">{shown.display_name || shown.name || t('nostrUnnamed')}</div>
              {shown.display_name && shown.name && <div className="t-body3 t-dim t-truncate">{shown.name}</div>}
              {shown.nip05 && <div className="t-body3 t-dim contacts-nostr__identifier">{shown.nip05}</div>}
              {shown.about && <div className="t-body3 t-dim t-truncate">{shown.about}</div>}
            </div>
          </div>
        )}
        {shown?.nip05 && (
          <div className="contacts-nostr__check">
            <Button variant="secondary" size="sm" loading={checkShown === 'checking'} disabled={checkShown === 'checking'} onClick={runCheck}>
              {t('nostrCheck')}
            </Button>
            {checkShown === 'yes' && <p className="t-body3">{t('nostrPointsHere')}</p>}
            {checkShown === 'no' && <p className="t-body3 t-dim">{t('nostrNotConfirmed')}</p>}
          </div>
        )}
      </div>
      {preview && (
        <Button fullWidth onClick={() => save(preview)}>
          {t('nostrLink')}
        </Button>
      )}
      {linked && (
        <Button
          variant="ghost"
          fullWidth
          onClick={() => {
            request.current++
            setLoading(false)
            save(null)
          }}
        >
          {t('nostrUnlink')}
        </Button>
      )}
    </section>
  )
}
