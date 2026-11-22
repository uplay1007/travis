import { useEffect, useId, useRef, useState } from 'react'
import { T, type Lang } from '../../i18n'
import styles from './FileMenu.module.css'

interface Props {
  lang: Lang
  busy: boolean
  onNew: () => void
  onOpen: () => void
  onSave: () => void
  onSaveAs: () => void
  onExport: (format: 'json' | 'sql' | 'drawio') => void
  onClose: () => void
}

export function FileMenu({ lang, busy, onNew, onOpen, onSave, onSaveAs, onExport, onClose }: Props) {
  const t = T[lang]
  const id = useId()
  const [open, setOpen] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrapper.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const choose = (action: () => void) => {
    setOpen(false)
    trigger.current?.focus()
    action()
  }

  const handleMenuKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
      return
    }
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    let next: number
    switch (event.key) {
      case 'ArrowDown': next = (current + 1) % items.length; break
      case 'ArrowUp': next = (current - 1 + items.length) % items.length; break
      case 'Home': next = 0; break
      case 'End': next = items.length - 1; break
      default: return
    }
    event.preventDefault()
    items[next]?.focus()
  }

  return (
    <div className={styles.wrapper} ref={wrapper} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }}>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? id : undefined}
        disabled={busy}
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => {
          if (event.key === 'Escape' && open) {
            event.stopPropagation()
            setOpen(false)
            return
          }
          if (event.key !== 'ArrowDown') return
          event.preventDefault()
          setOpen(true)
        }}
      >
        {t.file} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div ref={menu} id={id} className={styles.menu} role="menu" aria-label={t.file} onKeyDown={handleMenuKey}>
          <button role="menuitem" tabIndex={-1} type="button" onClick={() => choose(onNew)}>{t.newFile}</button>
          <button role="menuitem" tabIndex={-1} type="button" onClick={() => choose(onOpen)}>{t.openFile}</button>
          <button role="menuitem" tabIndex={-1} type="button" onClick={() => choose(onSave)}>{t.saveBtn}</button>
          <button role="menuitem" tabIndex={-1} type="button" onClick={() => choose(onSaveAs)}>{t.saveAs}</button>
          <div className={styles.exportGroup} role="group" aria-label={t.exportFile}>
            <div className={styles.groupLabel} aria-hidden="true">{t.exportFile}</div>
            <button role="menuitem" tabIndex={-1} type="button" aria-label={`${t.exportFile} JSON`} onClick={() => choose(() => onExport('json'))}>JSON</button>
            <button role="menuitem" tabIndex={-1} type="button" aria-label={`${t.exportFile} SQL`} onClick={() => choose(() => onExport('sql'))}>SQL</button>
            <button role="menuitem" tabIndex={-1} type="button" aria-label={`${t.exportFile} draw.io`} onClick={() => choose(() => onExport('drawio'))}>draw.io</button>
          </div>
          <button role="menuitem" tabIndex={-1} type="button" onClick={() => choose(onClose)}>{t.closeFile}</button>
        </div>
      )}
    </div>
  )
}
