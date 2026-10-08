import { useMemo } from 'react'
import { Globe } from 'lucide-react'
import { COUNTRIES, countryName } from '../countries'
import { t, ts } from '../i18n'
import { Flag } from './icons'
import type { GeoPreset } from '../types'
import { Dropdown, MenuItem, MultiSelect } from './ui'
import type { MultiOption } from './ui'

const OPTIONS: MultiOption[] = COUNTRIES.map((c) => ({ value: c.code, label: c.name, icon: <Flag code={c.code} />, hint: c.code }))

/** Searchable ISO country multi-select; presets add their countries to the selection. */
export function CountrySelect({ values, onChange, presets }: { values: string[]; onChange: (v: string[]) => void; presets?: GeoPreset[] }) {
  const upper = useMemo(() => values.map((v) => v.toUpperCase()), [values])
  return (
    <div className="country-select">
      <div className="grow">
        <MultiSelect
          values={upper}
          onChange={onChange}
          options={OPTIONS}
          placeholder={t('Search countries…')}
          chipLabel={(v) => (
            <span className="with-icon" title={countryName(v)}>
              <Flag code={v} />
              {v}
            </span>
          )}
        />
      </div>
      {presets && presets.length > 0 && (
        <Dropdown
          align="right"
          label={
            <>
              <Globe size={14} /> {t('Presets')}
            </>
          }
        >
          {(close) => (
            <div className="menu">
              {presets.map((p) => (
                <MenuItem
                  key={p.id}
                  onClick={() => {
                    const next = [...upper]
                    for (const c of p.countries) if (!next.includes(c.toUpperCase())) next.push(c.toUpperCase())
                    onChange(next)
                    close()
                  }}
                >
                  <span className="grow">{ts(p.name)}</span>
                  <span className="muted">{p.countries.length}</span>
                </MenuItem>
              ))}
              {values.length > 0 && (
                <MenuItem
                  danger
                  onClick={() => {
                    onChange([])
                    close()
                  }}
                >
                  {t('Clear all')}
                </MenuItem>
              )}
            </div>
          )}
        </Dropdown>
      )}
    </div>
  )
}

/** Single country picker as a plain select (filters). */
export const COUNTRY_SELECT_OPTIONS = COUNTRIES.map((c) => ({ value: c.code, label: `${c.name} (${c.code})` }))
