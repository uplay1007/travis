import styles from './RepositoryLink.module.css'

export function RepositoryLink() {
  return (
    <a
      className={styles.link}
      href="https://github.com/uplay1007/travis"
      target="_blank"
      rel="noopener noreferrer"
    >
      GitHub <span aria-hidden="true">↗</span>
    </a>
  )
}
