// Package whitepage stores uploaded whitepages on disk and serves them:
// static files directly, PHP through a sandboxed php-fpm container.
package whitepage

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"simpletds/internal/engine"
	"simpletds/internal/model"
)

const (
	maxFiles     = 3000
	maxTotalSize = 300 << 20
	maxPageSize  = 16 << 20
	// AssetPrefix is the public path under which whitepage files are served.
	AssetPrefix = "/_a/"
)

type Manager struct {
	Dir      string // whitepage root; must be the same path inside the PHP container
	FCGIAddr string // php-fpm address, empty when PHP is not available
}

func New(dir, fcgiAddr string) *Manager {
	os.MkdirAll(dir, 0o755)
	return &Manager{Dir: dir, FCGIAddr: fcgiAddr}
}

func (m *Manager) root(id int64) string { return filepath.Join(m.Dir, strconv.FormatInt(id, 10)) }

func (m *Manager) Delete(id int64) error { return os.RemoveAll(m.root(id)) }

// safeName rejects paths that escape the whitepage or name hidden files.
func safeName(name string) (string, bool) {
	name = strings.ReplaceAll(name, "\\", "/")
	clean := path.Clean("/" + name)[1:]
	if clean == "" || clean == "." {
		return "", false
	}
	for _, part := range strings.Split(clean, "/") {
		if strings.HasPrefix(part, ".") {
			return "", false
		}
	}
	return clean, true
}

// Save replaces a whitepage's files with an upload: a .zip archive, or a
// single .html / .php file. It updates wp's kind, entry and size fields.
func (m *Manager) Save(wp *model.Whitepage, filename string, data []byte) error {
	type file struct {
		name string
		open func() (io.ReadCloser, error)
	}
	var files []file
	ext := strings.ToLower(filepath.Ext(filename))
	switch ext {
	case ".zip":
		zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			return fmt.Errorf("not a valid zip archive: %w", err)
		}
		for _, f := range zr.File {
			if f.FileInfo().IsDir() || !f.Mode().IsRegular() {
				continue // directories are created as needed; links are never extracted
			}
			name, ok := safeName(f.Name)
			if !ok || strings.HasPrefix(name, "__MACOSX/") {
				continue
			}
			files = append(files, file{name, f.Open})
		}
	case ".html", ".htm", ".php":
		name := "index" + ext
		if ext == ".htm" {
			name = "index.html"
		}
		files = append(files, file{name, func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(data)), nil }})
	default:
		return errors.New("upload a .zip archive, or a single .html or .php file")
	}
	if len(files) == 0 {
		return errors.New("the upload contains no usable files")
	}
	if len(files) > maxFiles {
		return fmt.Errorf("too many files (limit %d)", maxFiles)
	}

	// Archives usually wrap everything in one folder: unwrap it.
	prefix := ""
	if i := strings.IndexByte(files[0].name, '/'); i > 0 {
		prefix = files[0].name[:i+1]
		for _, f := range files {
			if !strings.HasPrefix(f.name, prefix) {
				prefix = ""
				break
			}
		}
	}

	tmp := m.root(wp.ID) + ".new"
	os.RemoveAll(tmp)
	defer os.RemoveAll(tmp)
	var total int64
	var names []string
	for _, f := range files {
		name := strings.TrimPrefix(f.name, prefix)
		dst := filepath.Join(tmp, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		src, err := f.open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			src.Close()
			return err
		}
		// LimitReader guards against zip bombs: sizes in headers can lie.
		n, err := io.Copy(out, io.LimitReader(src, maxTotalSize-total+1))
		src.Close()
		out.Close()
		if err != nil {
			return err
		}
		if total += n; total > maxTotalSize {
			return fmt.Errorf("upload is larger than %d MB unpacked", maxTotalSize>>20)
		}
		names = append(names, name)
	}

	wp.Kind, wp.Entry = "html", ""
	sort.Strings(names)
	for _, n := range names {
		if strings.HasSuffix(strings.ToLower(n), ".php") {
			wp.Kind = "php"
		}
	}
	for _, want := range []string{"index.php", "index.html", "index.htm"} {
		for _, n := range names {
			if strings.EqualFold(n, want) && wp.Entry == "" {
				wp.Entry = n
			}
		}
	}
	if wp.Entry == "" {
		for _, n := range names {
			low := strings.ToLower(n)
			if !strings.Contains(n, "/") && (strings.HasSuffix(low, ".php") || strings.HasSuffix(low, ".html") || strings.HasSuffix(low, ".htm")) {
				wp.Entry = n
				break
			}
		}
	}
	if wp.Entry == "" {
		return errors.New("no index.html or index.php found at the top level of the upload")
	}
	wp.FileCount, wp.Size = len(names), total

	old := m.root(wp.ID) + ".old"
	os.RemoveAll(old)
	os.Rename(m.root(wp.ID), old)
	if err := os.Rename(tmp, m.root(wp.ID)); err != nil {
		os.Rename(old, m.root(wp.ID))
		return err
	}
	os.RemoveAll(old)
	return nil
}

type FileInfo struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

// Files lists a whitepage's files.
func (m *Manager) Files(id int64) []FileInfo {
	out := []FileInfo{}
	root := m.root(id)
	filepath.Walk(root, func(p string, fi os.FileInfo, err error) error {
		if err == nil && !fi.IsDir() {
			rel, _ := filepath.Rel(root, p)
			out = append(out, FileInfo{filepath.ToSlash(rel), fi.Size()})
		}
		return nil
	})
	return out
}

// Request is what a whitepage needs to know about the HTTP request.
type Request struct {
	Method   string
	URI      string // original request URI, as PHP should see it
	Query    string
	Host     string
	RemoteIP string
	Secure   bool
	Header   http.Header
	Body     []byte
	Env      map[string]string // extra $_SERVER entries
}

var errNotFound = errors.New("not found")

// resolve maps a sub-path to a file inside the whitepage.
func (m *Manager) resolve(wp *model.Whitepage, sub string) (string, error) {
	if sub == "" || strings.HasSuffix(sub, "/") {
		sub += wp.Entry
	}
	name, ok := safeName(sub)
	if !ok {
		return "", errNotFound
	}
	full := filepath.Join(m.root(wp.ID), filepath.FromSlash(name))
	fi, err := os.Stat(full)
	if err != nil || fi.IsDir() {
		return "", errNotFound
	}
	return full, nil
}

func isPHP(file string) bool { return strings.EqualFold(filepath.Ext(file), ".php") }

func (m *Manager) runPHP(ctx context.Context, wp *model.Whitepage, file string, req *Request) (int, http.Header, []byte, error) {
	if wp.Kind != "php" || m.FCGIAddr == "" {
		// Never fall through to serving PHP source as a static file.
		return 0, nil, nil, errNotFound
	}
	root := filepath.ToSlash(m.root(wp.ID))
	script := filepath.ToSlash(file)
	https := ""
	scheme := "http"
	if req.Secure {
		https, scheme = "on", "https"
	}
	p := map[string]string{
		"GATEWAY_INTERFACE": "CGI/1.1",
		"SERVER_PROTOCOL":   "HTTP/1.1",
		"SERVER_SOFTWARE":   "nginx",
		"REDIRECT_STATUS":   "200",
		"REQUEST_METHOD":    req.Method,
		"REQUEST_SCHEME":    scheme,
		"REQUEST_URI":       req.URI,
		"QUERY_STRING":      req.Query,
		"DOCUMENT_ROOT":     root,
		"SCRIPT_FILENAME":   script,
		"SCRIPT_NAME":       strings.TrimPrefix(script, root),
		"SERVER_NAME":       req.Host,
		"SERVER_PORT":       map[bool]string{true: "443", false: "80"}[req.Secure],
		"REMOTE_ADDR":       req.RemoteIP,
		"HTTPS":             https,
		"CONTENT_LENGTH":    strconv.Itoa(len(req.Body)),
		"CONTENT_TYPE":      req.Header.Get("Content-Type"),
		"HTTP_HOST":         req.Host,
	}
	for k, vals := range req.Header {
		// Hop-by-hop and proxy headers are not the page's business.
		switch k {
		case "Content-Type", "Content-Length", "Connection", "Host", "Proxy", "X-Forwarded-For", "X-Real-Ip", "Cf-Connecting-Ip":
			continue
		}
		p["HTTP_"+strings.ToUpper(strings.ReplaceAll(k, "-", "_"))] = strings.Join(vals, ", ")
	}
	for k, v := range req.Env {
		p[k] = v
	}
	return fcgiDo(ctx, m.FCGIAddr, p, req.Body)
}

var reHead = regexp.MustCompile(`(?i)<head[^>]*>`)

// injectBase makes relative asset URLs resolve under the whitepage's public
// path, so a page works unchanged on any campaign URL.
func injectBase(body []byte, key string) []byte {
	tag := []byte(`<base href="` + AssetPrefix + key + `/">`)
	if loc := reHead.FindIndex(body); loc != nil {
		out := make([]byte, 0, len(body)+len(tag))
		out = append(out, body[:loc[1]]...)
		out = append(out, tag...)
		return append(out, body[loc[1]:]...)
	}
	return append(tag, body...)
}

func contentType(file string) string {
	if ct := mime.TypeByExtension(strings.ToLower(filepath.Ext(file))); ct != "" {
		return ct
	}
	return "application/octet-stream"
}

// page produces the entry page (or a sub-page) fully in memory.
func (m *Manager) page(ctx context.Context, wp *model.Whitepage, sub string, req *Request) (*engine.Result, error) {
	file, err := m.resolve(wp, sub)
	if err != nil {
		return nil, err
	}
	res := &engine.Result{Status: http.StatusOK, Header: http.Header{}}
	if isPHP(file) {
		status, header, body, err := m.runPHP(ctx, wp, file, req)
		if err != nil {
			return nil, err
		}
		res.Status, res.Body = status, body
		res.ContentType = header.Get("Content-Type")
		res.Location = header.Get("Location")
		for k, vals := range header {
			switch k {
			case "Content-Type", "Location", "Content-Length", "X-Powered-By":
			default:
				res.Header[k] = vals // includes Set-Cookie
			}
		}
		if res.ContentType == "" {
			res.ContentType = "text/html; charset=utf-8"
		}
	} else {
		fi, err := os.Stat(file)
		if err != nil || fi.Size() > maxPageSize {
			return nil, errNotFound
		}
		if res.Body, err = os.ReadFile(file); err != nil {
			return nil, err
		}
		res.ContentType = contentType(file)
	}
	if wp.InjectBase && strings.HasPrefix(res.ContentType, "text/html") && res.Location == "" {
		res.Body = injectBase(res.Body, wp.Key)
	}
	return res, nil
}

// Render implements engine.WhitepageRenderer: it serves the entry page for a click.
func (m *Manager) Render(ctx context.Context, wp *model.Whitepage, v *engine.Visit) (*engine.Result, error) {
	req := &Request{Method: v.Method, URI: v.Path, Query: v.Query.Encode(), Host: v.Domain, RemoteIP: v.IP.String(),
		Secure: v.Secure, Header: v.Header, Body: v.Body,
		Env: map[string]string{
			"TDS_CLICK_ID": v.ClickID, "TDS_COUNTRY": v.Geo.Country, "TDS_CITY": v.Geo.City,
			"TDS_DEVICE": v.UA.DeviceType, "TDS_OS": v.UA.OS, "TDS_BROWSER": v.UA.Browser,
			"TDS_IS_BOT": strconv.FormatBool(v.Verdict.Bot), "TDS_CAMPAIGN": v.Campaign.Alias,
		}}
	if req.Method == "" {
		req.Method = http.MethodGet
	}
	if req.Header == nil {
		req.Header = http.Header{}
	}
	if req.Query != "" {
		req.URI += "?" + req.Query
	}
	return m.page(ctx, wp, "", req)
}

// Serve answers a request for any file of the whitepage: assets, sub-pages and
// form handlers. inject controls <base> injection (off in the panel preview,
// where relative URLs already resolve).
func (m *Manager) Serve(w http.ResponseWriter, r *http.Request, wp *model.Whitepage, sub string, req *Request, inject bool) {
	file, err := m.resolve(wp, sub)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	low := strings.ToLower(file)
	if !isPHP(file) && !strings.HasSuffix(low, ".html") && !strings.HasSuffix(low, ".htm") {
		// Plain assets: let net/http handle ranges, caching and types.
		w.Header().Set("Cache-Control", "public, max-age=3600")
		http.ServeFile(w, r, file)
		return
	}
	page := *wp
	page.InjectBase = wp.InjectBase && inject
	res, err := m.page(r.Context(), &page, sub, req)
	if err != nil {
		if errors.Is(err, errNotFound) {
			http.NotFound(w, r)
		} else {
			http.Error(w, "Bad Gateway", http.StatusBadGateway)
		}
		return
	}
	for k, vals := range res.Header {
		w.Header()[k] = vals
	}
	if res.Location != "" {
		w.Header().Set("Location", res.Location)
	}
	w.Header().Set("Content-Type", res.ContentType)
	w.WriteHeader(res.Status)
	w.Write(res.Body)
}
