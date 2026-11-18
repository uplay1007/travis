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

export async function writeToHandle(handle: FileSystemFileHandle, content: string): Promise<void> {
  const h = handle as unknown as { createWritable(): Promise<{ write(s: string): Promise<void>; close(): Promise<void> }> }
  const writable = await h.createWritable()
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
