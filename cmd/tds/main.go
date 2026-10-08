// Command tds runs the traffic distribution system.
//
//	tds                          start the server
//	tds panel-ip on|off          switch ip:port panel access (rescue from lockout)
//	tds reset-password USER      set a new random password for USER
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	_ "time/tzdata"

	"golang.org/x/crypto/bcrypt"

	"simpletds/internal/antibot"
	"simpletds/internal/engine"
	"simpletds/internal/events"
	"simpletds/internal/geo"
	"simpletds/internal/store"
	"simpletds/internal/web"
	"simpletds/internal/whitepage"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func randomString(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// loadSecret returns the signing secret, creating it on first start. Click
// ids and cookies are signed with it, so it must survive restarts.
func loadSecret(dataDir string) ([]byte, error) {
	if s := os.Getenv("TDS_SECRET"); len(s) >= 32 {
		return []byte(s), nil
	}
	path := filepath.Join(dataDir, "secret")
	if b, err := os.ReadFile(path); err == nil && len(b) >= 32 {
		return b, nil
	}
	b := []byte(randomString(48))
	return b, os.WriteFile(path, b, 0o600)
}

func ensureAdmin(ctx context.Context, st *store.Store) error {
	var n int
	if err := st.Pool.QueryRow(ctx, "SELECT count(*) FROM users").Scan(&n); err != nil || n > 0 {
		return err
	}
	user, pass := env("TDS_ADMIN_USER", "admin"), os.Getenv("TDS_ADMIN_PASSWORD")
	generated := pass == ""
	if generated {
		pass = randomString(15)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(pass), 12)
	if err != nil {
		return err
	}
	if _, err := st.Pool.Exec(ctx, "INSERT INTO users(username, password_hash) VALUES($1,$2)", user, string(hash)); err != nil {
		return err
	}
	if generated {
		// Printed once, to the container log only.
		fmt.Printf("\n==== first start: panel login is %q with password %q — change it in Settings ====\n\n", user, pass)
	}
	return nil
}

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})))
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	dataDir := env("TDS_DATA_DIR", "/data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return err
	}
	st, err := store.Open(ctx, env("TDS_POSTGRES_DSN", "postgres://tds:tds@postgres:5432/tds"))
	if err != nil {
		return err
	}
	defer st.Pool.Close()

	if len(os.Args) > 1 {
		return cli(ctx, st, os.Args[1:])
	}

	secret, err := loadSecret(dataDir)
	if err != nil {
		return err
	}
	if err := ensureAdmin(ctx, st); err != nil {
		return err
	}
	ev, err := events.Open(ctx, events.Config{
		Addr: env("TDS_CLICKHOUSE_ADDR", "clickhouse:9000"), Database: env("TDS_CLICKHOUSE_DB", "tds"),
		User: env("TDS_CLICKHOUSE_USER", "tds"), Password: env("TDS_CLICKHOUSE_PASSWORD", "tds"),
	})
	if err != nil {
		return err
	}
	defer ev.Close()

	settings, err := st.Settings(ctx)
	if err != nil {
		return err
	}
	if err := ev.SetRetention(ctx, settings.RetentionDays); err != nil {
		slog.Warn("could not apply retention", "err", err)
	}

	g := geo.New(filepath.Join(dataDir, "geo"))
	lists := antibot.NewLists(st, filepath.Join(dataDir, "lists"))
	eng := engine.New(st, ev, g, antibot.NewDetector(lists), secret)
	pages := whitepage.New(env("TDS_WHITEPAGE_DIR", filepath.Join(dataDir, "whitepages")), os.Getenv("TDS_PHP_FCGI"))
	eng.Pages = pages
	if err := eng.Reload(ctx); err != nil {
		return err
	}

	srv, err := web.New(web.Config{
		HTTPAddr: env("TDS_HTTP_ADDR", ":80"), HTTPSAddr: env("TDS_HTTPS_ADDR", ":443"), PanelAddr: env("TDS_PANEL_ADDR", ":8080"),
		DataDir: dataDir, Secret: secret, ForcePanelIP: os.Getenv("TDS_FORCE_PANEL_IP") == "1",
	}, st, ev, eng, g, lists, pages)
	if err != nil {
		return err
	}
	return srv.Run(ctx)
}

func cli(ctx context.Context, st *store.Store, args []string) error {
	switch {
	case len(args) == 2 && args[0] == "panel-ip" && (args[1] == "on" || args[1] == "off"):
		s, err := st.Settings(ctx)
		if err != nil {
			return err
		}
		s.PanelIPAccess = args[1] == "on"
		if err := st.SaveSettings(ctx, s); err != nil {
			return err
		}
		fmt.Println("ip:port panel access is now", args[1], "— restart the tds container to apply")
		return nil
	case len(args) == 2 && args[0] == "reset-password":
		pass := randomString(15)
		hash, err := bcrypt.GenerateFromPassword([]byte(pass), 12)
		if err != nil {
			return err
		}
		tag, err := st.Pool.Exec(ctx, "UPDATE users SET password_hash=$2, totp_enabled=false, totp_secret='' WHERE username=$1", args[1], string(hash))
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return fmt.Errorf("no user named %q", args[1])
		}
		st.Pool.Exec(ctx, "DELETE FROM sessions")
		fmt.Printf("new password for %s: %s (two-factor was switched off)\n", args[1], pass)
		return nil
	}
	return fmt.Errorf("unknown command %q; see: panel-ip on|off, reset-password USER", strings.Join(args, " "))
}
