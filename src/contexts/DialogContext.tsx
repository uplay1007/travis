import { createContext, useContext, useState, useCallback, ReactNode } from 'react'
import { Dialog, type DialogType } from '../components/ui/Dialog'

interface DialogState {
  isOpen: boolean
  type: DialogType
  title: string
  message: string
  defaultValue?: string
  resolve: (value?: any) => void
}

interface DialogContextValue {
  alert: (title: string, message: string) => Promise<void>
  confirm: (title: string, message: string) => Promise<boolean>
  prompt: (title: string, message: string, defaultValue?: string) => Promise<string | null>
}

const DialogContext = createContext<DialogContextValue | undefined>(undefined)

export function DialogProvider({ children, lang }: { children: ReactNode; lang: 'en' | 'ru' }) {
  const [state, setState] = useState<DialogState | null>(null)

  const show = useCallback((type: DialogType, title: string, message: string, defaultValue?: string) => {
    return new Promise<any>((resolve) => {
      setState({ isOpen: true, type, title, message, defaultValue, resolve })
    })
  }, [])

  const alert = (title: string, message: string) => show('alert', title, message)
  const confirm = (title: string, message: string) => show('confirm', title, message)
  const prompt = (title: string, message: string, defaultValue?: string) => show('prompt', title, message, defaultValue)

  const handleConfirm = (value?: string) => {
    if (!state) return
    const resolve = state.resolve
    setState(null)
    if (state.type === 'confirm') resolve(true)
    else if (state.type === 'prompt') resolve(value ?? '')
    else resolve()
  }

  const handleCancel = () => {
    if (!state) return
    const resolve = state.resolve
    setState(null)
    if (state.type === 'confirm') resolve(false)
    else if (state.type === 'prompt') resolve(null)
    else resolve()
  }

  return (
    <DialogContext.Provider value={{ alert, confirm, prompt }}>
      {children}
      {state && (
        <Dialog
          type={state.type}
          title={state.title}
          message={state.message}
          defaultValue={state.defaultValue}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
          lang={lang}
        />
      )}
    </DialogContext.Provider>
  )
}

export function useDialog() {
  const context = useContext(DialogContext)
  if (!context) throw new Error('useDialog must be used within DialogProvider')
  return context
}
