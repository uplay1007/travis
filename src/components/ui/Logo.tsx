import brightLogo from '../../assets/logo_bright.svg'
import darkLogo from '../../assets/logo_dark.svg'
import styles from './Logo.module.css'

// Theme-adaptive logo: bright (white) on dark theme, dark (black) on light
// theme. Both are rendered; CSS shows the right one based on html[data-theme],
// so it works everywhere regardless of the ThemeCtx provider tree.
export function Logo({ size = 18 }: { size?: number }) {
  return (
    <span className={styles.logo} style={{ width: size, height: size }}>
      <img className={styles.bright} src={brightLogo} alt="" width={size} height={size} />
      <img className={styles.dark} src={darkLogo} alt="" width={size} height={size} />
    </span>
  )
}
