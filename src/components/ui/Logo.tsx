import logoUrl from '../../assets/logo.svg'

export function Logo({ size = 18 }: { size?: number }) {
  return <img src={logoUrl} alt="" width={size} height={size} style={{ display: 'block' }} />
}
