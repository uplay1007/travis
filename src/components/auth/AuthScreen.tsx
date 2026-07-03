import { useState } from 'react'
import { supabase } from '../../services/supabase'
import { Logo } from '../ui/Logo'
import styles from './AuthScreen.module.css'

export function AuthScreen() {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({ email, password })
        if (error) throw error
        setDone(true)
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  if (done) {
    return (
      <div className={styles.overlay}>
        <div className={styles.card}>
          <div className={styles.successIcon}>📬</div>
          <h2 className={styles.successTitle}>Check your email</h2>
          <p className={styles.successText}>
            Confirmation link sent to <strong className={styles.successEmail}>{email}</strong>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.card}>
        <div className={styles.header}>
          <div className={styles.titleRow}>
            <Logo size={26} />
            <span className={styles.title}>TraVis</span>
          </div>
          <p className={styles.subtitle}>
            {mode === 'login' ? 'Sign in to your account' : 'Create a new account'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className={styles.form}>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className={styles.input}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            minLength={6}
            className={styles.input}
          />

          {error && <div className={styles.errorBox}>{error}</div>}

          <button type="submit" disabled={loading} className={styles.submitBtn}>
            {loading ? '...' : mode === 'login' ? 'Sign in' : 'Sign up'}
          </button>
        </form>

        <button
          onClick={() => { setMode(m => m === 'login' ? 'signup' : 'login'); setError('') }}
          className={styles.switchBtn}
        >
          {mode === 'login' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
        </button>
      </div>
    </div>
  )
}
