import { useEffect, useMemo, useState } from 'react'
import type { Contact, PubkeyHex } from '../../contracts'
import { actions, useIlchon } from '../../engine/browser'
import { useT } from '../../i18n'
import {
  AppBar,
  Avatar,
  Badge,
  BottomSheet,
  Button,
  Dialog,
  EmptyState,
  IconPlus,
  IconQr,
  IconSend,
  IconTrash,
  IconUsers,
  ListRow,
  TextField,
  useToast,
} from '../../ui'
import { NS } from './strings'
import './contacts.css'

export interface ContactsScreenProps {
  onOpenConnect: () => void
  onOpenRoom: (contactId: PubkeyHex) => void
}

const NAME_MAX = 24

function shortKey(pubkey: PubkeyHex): string {
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`
}

export function ContactsScreen({ onOpenConnect, onOpenRoom }: ContactsScreenProps) {
  const t = useT(NS)
  const toast = useToast()
  const contacts = useIlchon((s) => s.contacts)
  const matches = useIlchon((s) => s.matches)

  const [selectedId, setSelectedId] = useState<PubkeyHex | null>(null)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const matchedIds = useMemo(() => new Set(matches.map((m) => m.contactId)), [matches])
  const sorted = useMemo(
    () => [...contacts].sort((a, b) => b.createdAt - a.createdAt),
    [contacts],
  )
  const selected: Contact | undefined = selectedId
    ? contacts.find((c) => c.id === selectedId)
    : undefined

  // The contact can disappear under the sheet (deleted elsewhere).
  useEffect(() => {
    if (selectedId && !selected) {
      setSelectedId(null)
      setConfirmDelete(false)
    }
  }, [selectedId, selected])

  const openSheet = (c: Contact) => {
    setName(c.name)
    setSelectedId(c.id)
  }
  const closeSheet = () => {
    setSelectedId(null)
    setConfirmDelete(false)
  }

  const trimmed = name.trim()
  const nameChanged = selected ? trimmed !== selected.name : false

  const saveName = async () => {
    if (!selected || !nameChanged || saving) return
    setSaving(true)
    try {
      await actions.renameContact(selected.id, trimmed)
      toast.show(t('saved'), 'success')
    } catch {
      toast.show(t('saveFailed'), 'error')
    } finally {
      setSaving(false)
    }
  }

  const openRoom = () => {
    if (!selected) return
    const id = selected.id
    closeSheet()
    onOpenRoom(id)
  }

  const doDelete = async () => {
    if (!selected) return
    const id = selected.id
    setConfirmDelete(false)
    setSelectedId(null)
    try {
      await actions.deleteContact(id)
      toast.show(t('deleted'), 'info')
    } catch {
      toast.show(t('deleteFailed'), 'error')
    }
  }

  return (
    <div className="contacts">
      <AppBar
        title={t('title')}
        right={
          contacts.length > 0 ? (
            <span className="contacts__count num t-dim">{t('count', { n: contacts.length })}</span>
          ) : undefined
        }
      />

      <div className="ui-page ui-has-nav contacts__body">
        {sorted.length === 0 ? (
          <EmptyState
            icon={<IconUsers size={30} />}
            title={t('emptyTitle')}
            body={t('emptyBody')}
            action={
              <Button size="lg" leading={<IconQr size={20} />} onClick={onOpenConnect}>
                {t('connect')}
              </Button>
            }
          />
        ) : (
          <>
            <p className="contacts__intro t-body2 t-dim">{t('intro')}</p>
            <div className="contacts__list">
              {sorted.map((c, i) => (
                <ListRow
                  key={c.id}
                  leading={<Avatar seed={c.pubkey} name={c.name || undefined} size={44} />}
                  title={
                    c.name ? c.name : <span className="contacts__noname">{t('addName')}</span>
                  }
                  subtitle={<span className="num">{shortKey(c.pubkey)}</span>}
                  trailing={
                    matchedIds.has(c.id) ? <Badge tone="primary">{t('matched')}</Badge> : undefined
                  }
                  chevron
                  divider={i < sorted.length - 1}
                  onClick={() => openSheet(c)}
                />
              ))}
            </div>
            <div className="contacts__cta">
              <Button fullWidth size="lg" leading={<IconPlus size={20} />} onClick={onOpenConnect}>
                {t('connect')}
              </Button>
            </div>
          </>
        )}
      </div>

      <BottomSheet open={!!selected} onClose={closeSheet} title={t('sheetTitle')}>
        {selected && (
          <div className="contacts-sheet">
            <div className="contacts-sheet__who">
              <Avatar seed={selected.pubkey} name={selected.name || undefined} size={48} />
              <div className="ui-grow">
                <div className="t-body1 t-bold t-truncate">{selected.name || t('unnamed')}</div>
                <div className="t-body3 t-dim num">
                  {t('keyLabel', { key: shortKey(selected.pubkey) })}
                </div>
              </div>
              {matchedIds.has(selected.id) && <Badge tone="primary">{t('matched')}</Badge>}
            </div>

            <TextField
              label={t('nameLabel')}
              value={name}
              onChange={setName}
              placeholder={t('namePlaceholder')}
              helper={t('nameHelper')}
              maxLength={NAME_MAX}
              autoComplete="off"
              onEnter={saveName}
            />
            <Button
              variant="secondary"
              fullWidth
              disabled={!nameChanged}
              loading={saving}
              onClick={saveName}
            >
              {t('save')}
            </Button>

            <div className="contacts-sheet__actions">
              <Button fullWidth size="lg" leading={<IconSend size={20} />} onClick={openRoom}>
                {t('openRoom')}
              </Button>
              <Button
                variant="ghost"
                fullWidth
                leading={<IconTrash size={20} />}
                className="contacts-sheet__delete"
                onClick={() => setConfirmDelete(true)}
              >
                {t('delete')}
              </Button>
            </div>
          </div>
        )}
      </BottomSheet>

      <Dialog
        open={confirmDelete && !!selected}
        tone="danger"
        title={t('deleteTitle')}
        confirmLabel={t('deleteConfirm')}
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      >
        {t('deleteBody')}
      </Dialog>
    </div>
  )
}
