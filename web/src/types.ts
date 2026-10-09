// JSON shapes mirrored from internal/model/model.go and the API handlers.

export interface User {
  id: number
  username: string
  totp_enabled: boolean
  role: string
  enabled: boolean
}

export interface Share {
  campaign_id: number
  user_id: number
  access: string
  username: string
}

export interface DirectoryEntry {
  id: number
  username: string
}

export interface DomainGroup {
  id: number
  name: string
}

export interface Domain {
  id: number
  name: string
  group_id: number | null
  campaign_id: number | null
  tls_mode: string
  ip_source: string
  admin_enabled: boolean
  enabled: boolean
  status: string
  status_msg: string
  checked_at: string | null
  note: string
  created_at: string
}

/** One step of a campaign's conversion funnel; `key` is the conversion type postbacks send. */
export interface Stage {
  key: string
  name: string
  /** The stage that counts as the conversion (CR, CPA cost). */
  goal: boolean
  /** May be reported from the visitor's browser with only the click id. */
  public: boolean
}

export interface FunnelRow {
  key: string
  clicks: number
  uniques: number
  bots: number
  cost: number
  /** One entry per stage, in funnel order. */
  steps: { reached: number; events: number; revenue: number; median_sec?: number }[]
}

export interface Campaign {
  id: number
  name: string
  alias: string
  token: string
  enabled: boolean
  rotation: string
  cost_model: string
  cost_value: number
  currency: string
  unique_hours: number
  stages?: Stage[] | null
  note: string
  created_at: string
  owner_id: number
  /** The viewer's access: owner | edit | read | stats */
  access?: string
  owner_name?: string
}

export interface Filter {
  type: string
  mode: string
  values: string[]
}

export type ActionConfig = Record<string, unknown>

export interface Stream {
  id: number
  campaign_id: number
  name: string
  kind: string
  position: number
  weight: number
  enabled: boolean
  filter_op: string
  filters: Filter[] | null
  action_type: string
  action_config: ActionConfig | null
  js_check: boolean
  note: string
}

export interface Whitepage {
  id: number
  name: string
  key: string
  kind: string
  entry: string
  inject_base: boolean
  note: string
  file_count: number
  size: number
  created_at: string
}

export interface ConvKey {
  id: number
  name: string
  key: string
  enabled: boolean
  secret: string
  require_sig: boolean
  ip_allow: string[] | null
  rate_limit: number
  attribution: string
  require_click: boolean
  window_hours: number
  dedupe: boolean
  default_type: string
  default_revenue: number
  note: string
  created_at: string
}

export interface GeoPreset {
  id: number
  name: string
  countries: string[]
  builtin: boolean
}

export interface IPList {
  id: number
  name: string
  kind: string
  url: string
  content: string
  refresh_hours: number
  enabled: boolean
  builtin: boolean
  entries: number
  updated_at: string | null
  last_error: string
}

export interface Integration {
  id: number
  name: string
  kind: string
  enabled: boolean
  url: string
  headers: Record<string, string> | null
  timeout_ms: number
  cache_minutes: number
  mapping: Record<string, string> | null
}

export interface Settings {
  panel_ip_access: boolean
  admin_path: string
  session_hours: number
  proxy_protocol: boolean
  trusted_proxies: string[] | null
  acme_email: string
  acme_staging: boolean
  datacenter_is_bot: boolean
  header_checks: boolean
  tls_checks: boolean
  bot_threshold: number
  bot_asns: number[] | null
  datacenter_asns: number[] | null
  bot_ua_patterns: string[] | null
  ja3_block: string[] | null
  ja4_block: string[] | null
  js_pass_hours: number
  geo_city_url: string
  geo_asn_url: string
  maxmind_key: string
  geo_refresh_days: number
  retention_days: number
  /** Extra names of system request parameters: system name → names accepted next to it. */
  param_aliases: Record<string, string[]> | null
}

export interface ActionField {
  name: string
  label: string
  type: string
  options?: string[]
  default?: unknown
  help?: string
  required?: boolean
}

export interface ActionDef {
  type: string
  label: string
  description: string
  fields: ActionField[] | null
}

export interface FilterDef {
  type: string
  label: string
  group: string
  input: string
  options?: string[]
  help?: string
}

export interface IntegrationPreset {
  name: string
  kind: string
  url: string
  mapping: Record<string, string>
  description: string
}

export interface StreamPreset {
  /** Absent on built-in presets. */
  id?: number
  name: string
  kind: 'filters' | 'action' | string
  /** {filter_op, filters} or {action_type, action_config} */
  data: { filter_op?: string; filters?: Filter[] | null; action_type?: string; action_config?: ActionConfig | null }
  builtin?: boolean
}

/** A request parameter the tracker gives a meaning to, with every name it is accepted under. */
export interface SystemParam {
  name: string
  group: string
  label: string
  builtin: string[]
  aliases: string[]
  macro: boolean
}

export interface Meta {
  system_params?: SystemParam[] | null
  actions: ActionDef[]
  filters: FilterDef[]
  macros: string[]
  conversion_types: string[]
  cost_models: string[]
  report_groups: string[]
  integration_presets: IntegrationPreset[]
  postback_path: string
  event_prefix?: string
  max_stages?: number
  reserved_aliases: string[]
  stream_presets?: StreamPreset[] | null
  report_filters?: string[] | null
}

export interface GeoFileStatus {
  loaded: boolean
  updated: string
  size: number
}

export interface GeoStatus {
  city: GeoFileStatus
  asn: GeoFileStatus
  last_error: string
}

export interface SystemInfo {
  // stats, geo and panel are only sent to administrators.
  stats?: {
    queue_len: number
    clicks_written: number
    clicks_dropped: number
    uniq_entries: number
    domains: number
    campaigns: number
  }
  geo?: GeoStatus
  health: Record<string, string>
  panel?: {
    ip_access: boolean
    ip_access_force: boolean
    admin_domain_ok: boolean
    admin_path: string
  }
  php_enabled: boolean
  /** Public address of the server, for DNS hints; may be empty. */
  server_ip?: string
}

export interface ReportRow {
  key: string
  clicks: number
  uniques: number
  bots: number
  conversions: number
  rejected: number
  revenue: number
  cost: number
  profit: number
  cr: number
  roi: number
  epc: number
  types: Record<string, number> | null
}

export interface ReferrerRow extends ReportRow {
  /** Clicks from phones and tablets. */
  mobile: number
  desktop: number
}

export interface GeoInfo {
  country: string
  region: string
  city: string
  asn: number
  isp: string
}

export interface FilterTrace {
  type: string
  negated: boolean
  passed: boolean
}

export interface StreamTrace {
  id: number
  name: string
  kind: string
  matched: boolean
  chosen: boolean
  note?: string
  filters: FilterTrace[]
}

export interface SimResult {
  geo: GeoInfo
  device_type: string
  os: string
  browser: string
  bot: boolean
  datacenter: boolean
  score: number
  reasons: string[]
  streams: StreamTrace[]
  stream_id: number
  action: string
  note: string
}

export type Row = Record<string, unknown>

export interface ConvRow extends Row {
  params: Record<string, string>
}

/** What a click went on to do, as the click log carries it. */
export interface ClickEvent {
  ts: string
  type: string
  revenue: number
  goal: number
}

export interface Rejected {
  at: string
  ip: string
  key: string
  /** Name of the conversion key, empty when the key is unknown. */
  key_name?: string
  reason: string
  query: string
}

export interface WPFile {
  name: string
  size: number
}

export interface IntegrationSnippets {
  direct_url: string
  direct_note: string
  js: string
  php: string
  php_filename: string
}

export interface BulkAddResult {
  results: { name: string; ok: boolean; error?: string; id?: number }[]
  added: number
}

export interface IntegrationTestResult {
  response: unknown
  mapped: Record<string, unknown>
  is_bot?: boolean
}
