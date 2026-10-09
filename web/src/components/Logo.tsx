import { Split } from 'lucide-react'

/** The product name, as the panel shows it. A name, so it is not translated. */
export const APP_NAME = 'Crella'

/**
 * The mark: a path that splits, on a tile in the theme's accent colour. The
 * favicon (src/assets/logo.svg) is the same drawing with the colour fixed.
 */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden="true">
      <Split size={Math.round(size * 0.62)} />
    </span>
  )
}
