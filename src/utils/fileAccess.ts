// File System Access API — write back to the original file on disk
// Supported in Chrome/Edge/Opera. Falls back to download in Firefox/Safari.

export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && 'showOpenFilePicker' in window
}

export async function openFilePicker(accept: readonly string[]): Promise<FileSystemFileHandle | null> {
  try {
    // @ts-expect-error - File System Access API not yet in lib.dom.d.ts
    const [handle]: FileSystemFileHandle[] = await window.showOpenFilePicker({
      types: [{ description: 'Schema files', accept: { 'text/plain': [...accept] } }],
      multiple: false,
    })
    return handle
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null
    throw error
  }
}

interface SavePickerOptions {
  suggestedName: string
  types: { description: string; accept: Record<string, string[]> }[]
}

// null means the user cancelled. undefined means to use the browser's download flow.
export async function pickSaveFile(
  extension: string,
  mimeType: string,
  description: string,
): Promise<FileSystemFileHandle | null | undefined> {
  const pickerWindow = window as Window & {
    showSaveFilePicker?: (options: SavePickerOptions) => Promise<FileSystemFileHandle>
  }
  if (typeof pickerWindow.showSaveFilePicker !== 'function') return undefined

  try {
    return await pickerWindow.showSaveFilePicker({
      suggestedName: `schema.${extension}`,
      types: [{ description, accept: { [mimeType]: [`.${extension}`] } }],
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null
    if (error instanceof DOMException && error.name === 'SecurityError') return undefined
    throw error
  }
}

export function downloadTextFile(content: string, mimeType: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  // Let the browser start reading the object URL before releasing it.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function writeToHandle(handle: FileSystemFileHandle, content: string): Promise<void> {
  const writable = await handle.createWritable()
  await writable.write(content)
  await writable.close()
}

export async function getHandleFromDrop(e: DragEvent | React.DragEvent): Promise<FileSystemFileHandle | null> {
  const item = (e as DragEvent).dataTransfer?.items?.[0]
  if (!item) return null
  try {
    const anyItem = item as unknown as { getAsFileSystemHandle?: () => Promise<FileSystemHandle> }
    const handle = await anyItem.getAsFileSystemHandle?.()
    return handle?.kind === 'file' ? (handle as FileSystemFileHandle) : null
  } catch {
    return null
  }
}
