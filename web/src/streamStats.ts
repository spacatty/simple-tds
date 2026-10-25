import { usePref } from './hooks'
import { t } from './i18n'

/** How a stream's figures are drawn in its row: a choice kept on the account, made from the campaign menu. */
export type StatsStyle = 'line' | 'cols' | 'focus' | 'bar'
export const STATS_STYLES: { value: StatsStyle; label: string }[] = [
  { value: 'focus', label: t('Clicks first@@stats') },
  { value: 'line', label: t('One line@@stats') },
  { value: 'cols', label: t('Columns@@stats') },
  { value: 'bar', label: t('Share bar@@stats') },
]
export function useStatsStyle(): [StatsStyle, (v: StatsStyle) => void] {
  const [v, set] = usePref<string>('stream_stats', 'focus')
  return [STATS_STYLES.some((x) => x.value === v) ? (v as StatsStyle) : 'focus', set]
}
