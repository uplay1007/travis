import { useRef, useState } from 'react'
import { detectParser, parseSchema, schemaFileExtensions } from '../../utils/parsers'
import { openFilePicker, supportsFileSystemAccess } from '../../utils/fileAccess'
import { T, type Lang } from '../../i18n'
import type { Schema } from '../../types/schema'

export interface OpenResult {
  schema: Schema
  fileHandle?: FileSystemFileHandle
  positions?: Record<string, { x: number; y: number }>
  saveId?: string
  saveName?: string
}

export function useSchemaFile(lang: Lang, onOpen: (result: OpenResult) => void | Promise<void>) {
  const t = T[lang]
  const fileInput = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const [isOpening, setIsOpening] = useState(false)

  const openSchema = async (file?: File, handleRequest?: Promise<FileSystemFileHandle | null>) => {
    setError('')
    setIsOpening(true)
    try {
      const handle = await handleRequest
      if (!file) file = await handle?.getFile()
      if (!file) return
      const content = await file.text()
      const type = detectParser(file.name, content)
      const schema = parseSchema(content, type)
      if (!schema.tables.length && type !== 'json') throw new Error(t.noTablesFound)
      await onOpen({ schema, fileHandle: handle ?? undefined })
    } catch (error) {
      setError(error instanceof Error ? error.message : t.fileReadError)
    } finally {
      setIsOpening(false)
    }
  }

  const pickSchemaFile = async () => {
    setError('')
    if (supportsFileSystemAccess()) {
      try {
        const handle = await openFilePicker(schemaFileExtensions)
        if (handle) await openSchema(undefined, Promise.resolve(handle))
        return
      } catch {
        // The native picker can be blocked in embedded browsers.
      }
    }
    fileInput.current?.click()
  }

  return { fileInput, error, isOpening, openSchema, pickSchemaFile }
}
