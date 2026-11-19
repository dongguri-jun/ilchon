import { useT } from '../../i18n'
import { Button, IconCopy, useToast } from '../../ui'
import { copyText } from '../lock/util'
import './install-strings'

export function CopyLinkButton({ url }: { url: string }) {
  const t = useT('install')
  const toast = useToast()
  const copy = async () => {
    const ok = await copyText(url)
    toast.show(t(ok ? 'linkCopied' : 'linkCopyFailed'), ok ? 'success' : 'error')
  }
  return (
    <Button variant="secondary" leading={<IconCopy size={18} />} onClick={() => void copy()}>
      {t('copyLink')}
    </Button>
  )
}
