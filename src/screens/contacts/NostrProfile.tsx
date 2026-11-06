import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { Avatar, Badge, Button, TextField } from '../../ui'
import { fetchProfile, parseNpubOrHex, saveLinkedProfile, verifyNip05, type LinkedProfile } from '../../lib/nostr-profile'
import { NS } from './strings'

export function ProfileAvatar({ profile, seed, name, size = 44 }: { profile?: LinkedProfile | null; seed: string; name?: string; size?: number }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [profile?.picture])
  return profile?.picture && !failed
    ? <img className="contacts-nostr__picture" src={profile.picture} alt="" width={size} height={size} referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    : <Avatar seed={seed} name={name} size={size} />
}

export function NostrProfileSection({ contactId, linked, onChange }: {
  contactId: string
  linked: LinkedProfile | null
  onChange: () => void
}) {
  const t = useT(NS)
  const [input, setInput] = useState('')
  const [preview, setPreview] = useState<LinkedProfile | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const request = useRef(0)
  useEffect(() => () => { request.current++ }, [])
  const load = async () => {
    const id = ++request.current
    setPreview(null)
    setError('')
    const pubkey = parseNpubOrHex(input)
    if (!pubkey) { setError(t('nostrInvalid')); setLoading(false); return }
    setLoading(true)
    try {
      const profile = await fetchProfile(pubkey)
      if (request.current !== id) return
      if (!profile) { setError(t('nostrNotFound')); return }
      const nip05Verified = profile.nip05 ? await verifyNip05(profile.nip05, pubkey) : false
      if (request.current === id) setPreview({ ...profile, pubkey, nip05Verified })
    } catch {
      if (request.current === id) setError(t('nostrNotFound'))
    } finally {
      if (request.current === id) setLoading(false)
    }
  }
  const save = (profile: LinkedProfile | null) => {
    if (!saveLinkedProfile(contactId, profile)) { setError(t('nostrStorageFailed')); return }
    setError('')
    setPreview(null)
    onChange()
  }
  const shown = preview || linked
  return <section className="contacts-nostr" aria-label={t('nostrTitle')}>
    <h3 className="t-body1 t-bold">{t('nostrTitle')}</h3>
    <p className="t-body3 t-dim">{t('nostrPrivacy')}</p>
    <p className="contacts-nostr__warning t-body3">{t('nostrWarning')}</p>
    <TextField label={t('nostrInput')} value={input} onChange={(value) => {
      request.current++
      setLoading(false)
      setInput(value)
      setPreview(null)
      setError('')
    }} placeholder="npub1… / nprofile1… / hex" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={5000} onEnter={load} />
    <Button variant="secondary" fullWidth loading={loading} disabled={!input.trim() || loading} onClick={load}>{t('nostrLoad')}</Button>
    {error && <p className="contacts-nostr__error t-body3" role="alert">{error}</p>}
    <div aria-live="polite" aria-busy={loading}>
      {shown && <div className="contacts-nostr__preview">
        <ProfileAvatar profile={shown} seed={shown.pubkey} name={shown.display_name || shown.name} size={44} />
        <div className="contacts-nostr__details">
          <div className="t-body2 t-bold t-truncate">{shown.display_name || shown.name || t('nostrUnnamed')}</div>
          {shown.display_name && shown.name && <div className="t-body3 t-dim t-truncate">{shown.name}</div>}
          {shown.nip05 && <div className="t-body3 t-dim contacts-nostr__identifier">{shown.nip05} {shown.nip05Verified && <Badge tone="primary">{t('nostrVerified')}</Badge>}</div>}
          {shown.about && <div className="t-body3 t-dim t-truncate">{shown.about}</div>}
        </div>
      </div>}
    </div>
    {preview && <Button fullWidth onClick={() => save(preview)}>{t('nostrLink')}</Button>}
    {linked && <Button variant="ghost" fullWidth onClick={() => {
      request.current++
      setLoading(false)
      save(null)
    }}>{t('nostrUnlink')}</Button>}
  </section>
}
