import { createContext } from 'react'

export type Theme = 'dark' | 'light'
export const ThemeCtx = createContext<Theme>('dark')
