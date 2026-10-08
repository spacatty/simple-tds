// Thin fetch wrapper. All URLs are relative ("api/...") because the panel is
// mounted at "/" on ip:port and under "/<admin-path>/" on domains.

export class ApiError extends Error {
  status: number
  data: Record<string, unknown>
  constructor(status: number, message: string, data: Record<string, unknown>) {
    super(message)
    this.status = status
    this.data = data
  }
}

let unauthorizedHandler: () => void = () => {}
export function onUnauthorized(fn: () => void) {
  unauthorizedHandler = fn
}

export type Params = Record<string, string | number | boolean | null | undefined>

export function qs(params?: Params): string {
  if (!params) return ''
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    // An empty f.<dimension> is a real filter ("no country"); every other empty value means "not set".
    if (v === '' && !k.startsWith('f.')) continue
    sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? '?' + s : ''
}

interface Options {
  method?: string
  body?: unknown
  form?: FormData
  /** Do not trigger the global login redirect on 401 (used by the login form itself). */
  quiet401?: boolean
}

export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined || opts.form ? 'POST' : 'GET')
  const headers: Record<string, string> = {}
  let body: BodyInit | undefined
  if (opts.form) {
    body = opts.form
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  if (method !== 'GET') headers['X-TDS'] = '1'

  let res: Response
  try {
    res = await fetch('api/' + path.replace(/^\/+/, ''), { method, headers, body, credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, 'Network error: the server is unreachable', {})
  }
  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }
  if (!res.ok) {
    const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
    const msg = typeof obj.error === 'string' ? obj.error : `Request failed (${res.status})`
    if (res.status === 401 && !opts.quiet401) unauthorizedHandler()
    throw new ApiError(res.status, msg, obj)
  }
  return data as T
}

export const get = <T>(path: string, params?: Params) => api<T>(path + qs(params))
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body ?? {} })
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body })
export const del = <T = { ok: boolean }>(path: string) => api<T>(path, { method: 'DELETE' })
export const upload = <T>(path: string, form: FormData) => api<T>(path, { method: 'POST', form })

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
