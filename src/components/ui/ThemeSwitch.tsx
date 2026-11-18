import styles from './ThemeSwitch.module.css'

interface Props {
  theme: 'dark' | 'light'
  onToggle: () => void
}

export function ThemeSwitch({ theme, onToggle }: Props) {
  return (
    <div className={styles.switch} title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
      <label className={styles.label}>
        <input
          type="checkbox"
          aria-label="Light theme"
          className={styles.checkbox}
          checked={theme === 'light'}
          onChange={onToggle}
        />
        <span className={styles.slider} />
      </label>
    </div>
  )
}
