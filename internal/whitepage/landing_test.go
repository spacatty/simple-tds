package whitepage

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"simpletds/internal/model"
)

func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// Tokens are found in text files only; of those, only non-pages are listed as
// rendered per visitor (pages always are).
func TestScan(t *testing.T) {
	m := New(t.TempDir(), "", "")
	writeFiles(t, m.root(1), map[string]string{
		"index.html":  "<title>CRELLA_VAR_TITLE</title> CRELLA_VAR_A_B CRELLA_VAR_lower CRELLA_VAR_",
		"js/app.js":   `var x = "CRELLA_VAR_API";`,
		"style.css":   "body{}",
		"lead.php":    `<?php $_SERVER["CRELLA_VAR_DSN"];`,
		"picture.png": "CRELLA_VAR_BINARY",
	})
	vars, templated := m.Scan(1)
	if want := []string{"API", "A_B", "DSN", "TITLE"}; !reflect.DeepEqual(vars, want) {
		t.Fatalf("vars: got %v, want %v", vars, want)
	}
	if want := []string{"js/app.js"}; !reflect.DeepEqual(templated, want) {
		t.Fatalf("templated: got %v, want %v", templated, want)
	}
}

func TestFill(t *testing.T) {
	out := map[string]string{"TITLE": "Hello", "TITLE_LONG": "Long", "EMPTY": ""}
	got := string(fill([]byte("CRELLA_VAR_TITLE CRELLA_VAR_TITLE_LONG [CRELLA_VAR_EMPTY] CRELLA_VAR_SECRET CRELLA_VAR_TITLE_"), out))
	// A longer name is its own variable; an unknown one (or a server-only one) stays as written.
	if want := "Hello Long [] CRELLA_VAR_SECRET Hello_"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestWriteFile(t *testing.T) {
	m := New(t.TempDir(), "", "")
	wp := &model.Whitepage{ID: 3}
	if err := m.WriteFile(wp, "index.html", []byte("<p>x</p>")); err != nil {
		t.Fatal(err)
	}
	if err := m.WriteFile(wp, "api/lead.php", []byte("<?php")); err != nil {
		t.Fatal(err)
	}
	if wp.Kind != "php" || wp.FileCount != 2 || wp.Size != 13 {
		t.Fatalf("got kind %q, %d files, %d bytes", wp.Kind, wp.FileCount, wp.Size)
	}
	// A path cannot leave the landing's folder, and only text is edited here.
	if err := m.WriteFile(wp, "../../escape.html", []byte("x")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(m.root(3), "escape.html")); err != nil {
		t.Fatalf("the path was not confined to the landing: %v", err)
	}
	if err := m.WriteFile(wp, "image.png", []byte("x")); err == nil {
		t.Fatal("a binary file was accepted")
	}
	if err := m.WriteFile(wp, ".htaccess.txt", []byte("x")); err == nil {
		t.Fatal("a hidden file was accepted")
	}
	if _, err := m.ReadFile(3, "api/lead.php"); err != nil {
		t.Fatal(err)
	}
}
