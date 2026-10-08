import { useMemo } from 'react'
import { Globe } from 'lucide-react'
import { COUNTRIES, countryName, flag } from '../countries'
import type { GeoPreset } from '../types'
import { Dropdown, MenuItem, MultiSelect } from './ui'
import type { MultiOption } from './ui'

const OPTIONS: MultiOption[] = COUNTRIES.map((c) => ({ value: c.code, label: c.name, prefix: flag(c.code), hint: c.code }))

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
          placeholder="Search countries…"
          chipLabel={(v) => (
            <span title={countryName(v)}>
              {flag(v)} {v}
            </span>
          )}
        />
      </div>
      {presets && presets.length > 0 && (
        <Dropdown
          align="right"
          label={
            <>
              <Globe size={14} /> Presets
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
                  <span className="grow">{p.name}</span>
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
                  Clear all
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
