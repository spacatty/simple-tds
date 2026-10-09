package whitepage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"simpletds/internal/engine"
	"simpletds/internal/model"
)

// Landings are stored and served like whitepages; what they add is variables:
// CRELLA_VAR_<NAME> tokens in their files, filled in per visitor.

// maxTextSize caps a file that is scanned for variables, edited in the panel
// or rendered per visitor.
const maxTextSize = 2 << 20

var reVar = regexp.MustCompile(model.LandingVarPrefix + `([A-Z0-9]+(?:_[A-Z0-9]+)*)`)

// textExt are the files variables are looked for in.
var textExt = map[string]bool{".html": true, ".htm": true, ".php": true, ".js": true, ".mjs": true, ".css": true,
	".json": true, ".svg": true, ".xml": true, ".txt": true, ".webmanifest": true}

func isText(name string) bool { return textExt[strings.ToLower(filepath.Ext(name))] }

func isPage(name string) bool {
	low := strings.ToLower(name)
	return strings.HasSuffix(low, ".php") || strings.HasSuffix(low, ".html") || strings.HasSuffix(low, ".htm")
}

// Sub is a manager over a folder inside this one. Landings live in one, so
// the PHP sandbox sees them through the mount it already has.
func (m *Manager) Sub(name string) *Manager {
	return New(filepath.Join(m.Dir, name), m.FCGIAddr, m.PHPDir+"/"+name)
}

// Scan reads the landing's text files and returns the variables they name
// and the files, other than pages, that carry any.
func (m *Manager) Scan(id int64) (vars, templated []string) {
	seen := map[string]bool{}
	root := m.root(id)
	filepath.Walk(root, func(p string, fi os.FileInfo, err error) error {
		if err != nil || fi.IsDir() || !isText(p) || fi.Size() > maxTextSize {
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return nil
		}
		found := reVar.FindAllSubmatch(data, -1)
		for _, f := range found {
			seen[string(f[1])] = true
		}
		if rel, err := filepath.Rel(root, p); err == nil && len(found) > 0 && !isPage(p) {
			templated = append(templated, filepath.ToSlash(rel))
		}
		return nil
	})
	for name := range seen {
		vars = append(vars, name)
	}
	sort.Strings(vars)
	sort.Strings(templated)
	return vars, templated
}

// ReadFile returns a text file of the landing for the panel's editor.
func (m *Manager) ReadFile(id int64, name string) ([]byte, error) {
	name, ok := safeName(name)
	if !ok {
		return nil, errNotFound
	}
	full := filepath.Join(m.root(id), filepath.FromSlash(name))
	fi, err := os.Stat(full)
	if err != nil || fi.IsDir() {
		return nil, errNotFound
	}
	if !isText(name) || fi.Size() > maxTextSize {
		return nil, errors.New("only text files up to 2 MB can be edited here")
	}
	return os.ReadFile(full)
}

// WriteFile stores one text file of the landing, creating it if needed, and
// brings wp's kind and size fields up to date.
func (m *Manager) WriteFile(wp *model.Whitepage, name string, data []byte) error {
	name, ok := safeName(name)
	if !ok || !isText(name) {
		return errors.New("only text files can be edited here: html, php, js, css, json, svg, xml, txt")
	}
	if len(data) > maxTextSize {
		return errors.New("only text files up to 2 MB can be edited here")
	}
	full := filepath.Join(m.root(wp.ID), filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	// Written aside and renamed, so a visitor never gets half a file.
	tmp := filepath.Join(filepath.Dir(full), ".tmp-"+filepath.Base(full))
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, full); err != nil {
		os.Remove(tmp)
		return err
	}
	files := m.Files(wp.ID)
	wp.Kind, wp.FileCount, wp.Size = "html", len(files), 0
	for _, f := range files {
		wp.Size += f.Size
		if isPHP(f.Name) {
			wp.Kind = "php"
		}
	}
	return nil
}

// CopyFrom fills the (new) entry id with the files of src's entry srcID.
func (m *Manager) CopyFrom(src *Manager, srcID, id int64) error {
	from, to := src.root(srcID), m.root(id)
	return filepath.Walk(from, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(from, p)
		if err != nil {
			return err
		}
		dst := filepath.Join(to, rel)
		if fi.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		if !fi.Mode().IsRegular() {
			return nil
		}
		in, err := os.Open(p)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, in); err != nil {
			out.Close()
			return err
		}
		return out.Close()
	})
}

// fill replaces the variable tokens the landing declares; a token of an
// unknown or server-only variable is left as it is.
func fill(body []byte, out map[string]string) []byte {
	if len(out) == 0 || !bytes.Contains(body, []byte(model.LandingVarPrefix)) {
		return body
	}
	return reVar.ReplaceAllFunc(body, func(tok []byte) []byte {
		if val, ok := out[string(tok[len(model.LandingVarPrefix):])]; ok {
			return []byte(val)
		}
		return tok
	})
}

// textual reports whether a response is text that tokens may sit in.
func textual(contentType string) bool {
	ct := strings.ToLower(contentType)
	for _, part := range []string{"text/", "javascript", "json", "xml"} {
		if strings.Contains(ct, part) {
			return true
		}
	}
	return false
}

func fillResult(res *engine.Result, vals *engine.LandingValues) {
	if res.Location == "" && textual(res.ContentType) {
		res.Body = fill(res.Body, vals.Out)
	}
}

func withEnv(req *Request, env map[string]string) {
	if req.Env == nil {
		req.Env = map[string]string{}
	}
	for k, v := range env {
		req.Env[k] = v
	}
}

// RenderLanding implements engine.LandingRenderer: the entry page for a click
// with the variables filled in.
func (m *Manager) RenderLanding(ctx context.Context, l *model.Landing, v *engine.Visit, vals *engine.LandingValues) (*engine.Result, error) {
	req := visitRequest(v)
	withEnv(req, vals.Env)
	res, err := m.page(ctx, l.Page(), "", req)
	if err != nil {
		return nil, err
	}
	fillResult(res, vals)
	return res, nil
}

// ServeLanding answers a request for any file of the landing. Pages and the
// files that carry variables are rendered for this visitor, with the values
// vals returns; everything else is a plain cacheable asset.
func (m *Manager) ServeLanding(w http.ResponseWriter, r *http.Request, l *model.Landing, sub string, req *Request, vals func() *engine.LandingValues, inject bool) {
	page := l.Page()
	file, err := m.resolve(page, sub)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	rel, _ := filepath.Rel(m.root(l.ID), file)
	rel = filepath.ToSlash(rel)
	templated := false
	for _, name := range l.Templated {
		templated = templated || name == rel
	}
	switch {
	case isPage(file):
		v := vals()
		withEnv(req, v.Env)
		page.InjectBase = l.InjectBase && inject
		res, err := m.page(r.Context(), page, sub, req)
		if err == nil {
			fillResult(res, v)
			if res.Header.Get("Cache-Control") == "" {
				res.Header.Set("Cache-Control", "private, no-store")
			}
		}
		writePage(w, r, res, err)
	case templated:
		fi, err := os.Stat(file)
		if err != nil || fi.Size() > maxTextSize {
			http.NotFound(w, r)
			return
		}
		body, err := os.ReadFile(file)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		// Per visitor: no shared cache may keep it.
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("Content-Type", contentType(file))
		w.Write(fill(body, vals().Out))
	default:
		w.Header().Set("Cache-Control", "public, max-age=3600")
		http.ServeFile(w, r, file)
	}
}
