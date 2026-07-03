import { useState, useEffect, useRef } from 'react'
import styles from './Dialog.module.css'

export type DialogType = 'alert' | 'confirm' | 'prompt'

interface DialogProps {
  type: DialogType
  title: string
  message: string
  defaultValue?: string
  onConfirm: (value?: string) => void
  onCancel: () => void
  lang: 'en' | 'ru'
}

export function Dialog({ type, title, message, defaultValue = '', onConfirm, onCancel, lang }: DialogProps) {
  const [value, setValue] = useState(defaultValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (type === 'prompt') {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [type])

  const handleConfirm = () => {
    onConfirm(type === 'prompt' ? value : undefined)
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <h3 className={styles.headerTitle}>{title}</h3>
          <button onClick={onCancel} className={styles.closeBtn}>×</button>
        </div>

        <div className={styles.body}>
          <p className={styles.message}>{message}</p>

          {type === 'prompt' && (
            <input
              ref={inputRef}
              value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleConfirm()
                if (e.key === 'Escape') onCancel()
              }}
              className={styles.promptInput}
              placeholder="..."
            />
          )}
        </div>

        <div className={styles.footer}>
          {type !== 'alert' && (
            <button onClick={onCancel} className={styles.cancelBtn}>
              {lang === 'ru' ? 'Отмена' : 'Cancel'}
            </button>
          )}
          <button onClick={handleConfirm} className={styles.confirmBtn}>
            {type === 'alert' ? (lang === 'ru' ? 'Понятно' : 'OK') : (lang === 'ru' ? 'Подтвердить' : 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
