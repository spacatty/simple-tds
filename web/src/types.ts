// JSON shapes mirrored from internal/model/model.go and the API handlers.

export interface User {
  id: number
  username: string
  totp_enabled: boolean
  role: string
  enabled: boolean
  /** The user's own panel preferences; see usePref. */
  prefs?: Record<string, string> | null
}

export interface Share {
  campaign_id: number
  user_id: number
  access: string
  username: string
}

export interface CampaignGroup {
  id: number
  owner_id: number
  name: string
  /** The viewer's access: owner | edit | read | stats */
  access?: string
  owner_name?: string
}

export interface GroupShare {
  group_id: number
  user_id: number
  access: string
  username: string
}

/** One tile of a user's own dashboard. */
export interface BoardWidget {
  id: string
  type: 'stat' | 'chart' | 'funnel' | 'top' | 'domains'
  title?: string
  campaign_id?: number
  stream_id?: number
  metric?: string
  dim?: string
  /** Width in twelfths of the board. */
  w: number
  /** Height in pixels; absent or zero fits the content. */
  h?: number
}

/** A user's own dashboard. */
export interface Board {
  id: number
  name: string
  position: number
  widgets: BoardWidget[] | null
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
  /** Sum of the blocklist answers: '' (not checked) | clean | listed | unknown */
  rep_status: string
  reputation: RepResult[] | null
  rep_checked_at: string | null
}

/** One blocklist provider's answer about a domain. */
export interface RepResult {
  provider: string
  status: 'clean' | 'listed' | 'error' | string
  detail?: string
  /** The provider's own page about the domain. */
  url?: string
  checked_at: string
}

/** A blocklist provider, as the server describes it. */
export interface RepProviderDef {
  id: string
  name: string
  short: string
  description: string
  /** '' (no key) | required | optional */
  key: string
  key_help?: string
  key_url?: string
  threshold?: boolean
  rate?: boolean
}

export interface RepProviderConfig {
  enabled: boolean
  key?: string
  threshold?: number
  per_minute?: number
}

/** One step of a campaign's conversion funnel; `key` is the conversion type postbacks send. */
export interface Stage {
  key: string
  name: string
  /** The stage that counts as the conversion (CR, CPA cost). */
  goal: boolean
  /** May be reported from the visitor's browser with only the click id. */
  public: boolean
  /** The ways the stage can end; an event names one with its `outcome` parameter. */
  outcomes?: Outcome[] | null
}

/** One result of a stage: a success, a failure or neither. */
export interface Outcome {
  key: string
  name: string
  kind: '' | 'ok' | 'fail'
  /** The key is the stage key, "_" and a suffix, and follows the stage key when that changes. */
  linked?: boolean
}

/** A user's reusable set of funnel stages; applying it copies the stages into a campaign. */
export interface FunnelPreset {
  id: number
  name: string
  note: string
  stages: Stage[]
  /** Grows every time the stages change. */
  rev: number
  created_at: string
}

export interface FunnelRow {
  key: string
  clicks: number
  uniques: number
  bots: number
  cost: number
  /** One entry per stage, in funnel order. */
  steps: { reached: number; events: number; revenue: number; median_sec?: number; outcomes?: { reached: number; events: number }[] | null }[]
}

export interface Campaign {
  id: number
  /** The owner's group the campaign is filed under; null when none, or when the viewer cannot see the group. */
  group_id?: number | null
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
  /** The preset the stages were copied from, and its revision then; the preset is visible to its owner only. */
  funnel_preset_id?: number | null
  funnel_preset_rev?: number
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
  /** Kept in the stream but left out of matching. */
  bypass?: boolean
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

export interface LandingVar {
  /** Without the prefix: TITLE for the token CRELLA_VAR_TITLE. */
  name: string
  label: string
  /** text | html | url | js | server — where the value goes, and so how it is escaped. */
  kind: string
  default: string
  /** The token occurs in the landing's files. */
  used: boolean
}

export interface LandingPreset {
  id: number
  name: string
  /** Variables the preset sets; the rest keep their defaults. */
  values: Record<string, string> | null
}

export interface Landing {
  id: number
  name: string
  key: string
  kind: string
  entry: string
  inject_base: boolean
  note: string
  file_count: number
  size: number
  vars: LandingVar[] | null
  presets: LandingPreset[] | null
  /** Files other than pages that carry variables and are rendered per visitor. */
  templated: string[] | null
  created_at: string
}

/** What a stream form knows of a landing. For someone else's landing the values are not included. */
export interface LandingRef {
  id: number
  name: string
  vars: { name: string; label: string; kind: string; default?: string }[] | null
  presets: { id: number; name: string; values?: Record<string, string> | null }[] | null
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
  reputation?: { interval_hours: number; providers: Record<string, RepProviderConfig> | null }
}

/** A source whose requests never reach its owner's campaigns. */
export interface SuppressRule {
  id: number
  owner_id: number
  kind: 'ip' | 'referer'
  value: string
  /** Empty: every campaign the owner has. */
  campaign_ids: number[] | null
  /** What the rule keeps about the requests it refuses. */
  store: 'off' | 'count' | 'log'
  created_at: string
}

export interface ActionField {
  name: string
  label: string
  type: string
  /** Code fields: html | javascript. */
  lang?: string
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
  max_outcomes?: number
  reserved_aliases: string[]
  landing_var_prefix?: string
  landing_var_kinds?: string[]
  stream_presets?: StreamPreset[] | null
  report_filters?: string[] | null
  reputation_providers?: RepProviderDef[] | null
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
  /** Ids of the blocklist providers domains are checked against. */
  reputation?: string[] | null
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
  bypassed?: boolean
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
  outcome?: string
  revenue: number
  goal: number
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
