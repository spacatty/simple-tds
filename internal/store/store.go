// Package store is the Postgres-backed configuration store. Nothing here is on
// the click path: the engine works from an in-memory snapshot built from it.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"simpletds/internal/model"
)

var ErrNotFound = errors.New("not found")
var ErrConflict = errors.New("already exists")

type Store struct {
	Pool *pgxpool.Pool
}

func Open(ctx context.Context, dsn string) (*Store, error) {
	var pool *pgxpool.Pool
	var err error
	// The database container may still be starting.
	for i := 0; i < 60; i++ {
		pool, err = pgxpool.New(ctx, dsn)
		if err == nil {
			if err = pool.Ping(ctx); err == nil {
				break
			}
			pool.Close()
		}
		time.Sleep(time.Second)
	}
	if err != nil {
		return nil, fmt.Errorf("postgres: %w", err)
	}
	s := &Store{Pool: pool}
	if _, err := pool.Exec(ctx, schema); err != nil {
		return nil, fmt.Errorf("postgres schema: %w", err)
	}
	if _, err := pool.Exec(ctx, migrations); err != nil {
		return nil, fmt.Errorf("postgres migrations: %w", err)
	}
	return s, s.seed(ctx)
}

const schema = `
CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id bigserial PRIMARY KEY, username text UNIQUE NOT NULL, password_hash text NOT NULL,
  totp_secret text NOT NULL DEFAULT '', totp_enabled boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS domain_groups (id bigserial PRIMARY KEY, name text UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS campaigns (
  id bigserial PRIMARY KEY, name text NOT NULL, alias text UNIQUE NOT NULL, token text NOT NULL,
  enabled boolean NOT NULL DEFAULT true, rotation text NOT NULL DEFAULT 'position',
  cost_model text NOT NULL DEFAULT 'none', cost_value double precision NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD', unique_hours int NOT NULL DEFAULT 24,
  note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS domains (
  id bigserial PRIMARY KEY, name text UNIQUE NOT NULL,
  group_id bigint REFERENCES domain_groups(id) ON DELETE SET NULL,
  campaign_id bigint REFERENCES campaigns(id) ON DELETE SET NULL,
  tls_mode text NOT NULL DEFAULT 'auto', ip_source text NOT NULL DEFAULT 'direct',
  admin_enabled boolean NOT NULL DEFAULT false, enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'pending', status_msg text NOT NULL DEFAULT '',
  checked_at timestamptz, note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS streams (
  id bigserial PRIMARY KEY, campaign_id bigint NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name text NOT NULL, kind text NOT NULL DEFAULT 'regular', position int NOT NULL DEFAULT 0,
  weight int NOT NULL DEFAULT 100, enabled boolean NOT NULL DEFAULT true,
  filter_op text NOT NULL DEFAULT 'and', filters jsonb NOT NULL DEFAULT '[]',
  action_type text NOT NULL DEFAULT 'status', action_config jsonb NOT NULL DEFAULT '{}',
  js_check boolean NOT NULL DEFAULT false, note text NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS streams_campaign ON streams(campaign_id);
CREATE TABLE IF NOT EXISTS whitepages (
  id bigserial PRIMARY KEY, name text NOT NULL, key text UNIQUE NOT NULL, kind text NOT NULL DEFAULT 'html',
  entry text NOT NULL DEFAULT 'index.html', inject_base boolean NOT NULL DEFAULT true,
  note text NOT NULL DEFAULT '', file_count int NOT NULL DEFAULT 0, size bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS conv_keys (
  id bigserial PRIMARY KEY, name text NOT NULL, key text UNIQUE NOT NULL, enabled boolean NOT NULL DEFAULT true,
  secret text NOT NULL DEFAULT '', require_sig boolean NOT NULL DEFAULT false,
  ip_allow jsonb NOT NULL DEFAULT '[]', rate_limit int NOT NULL DEFAULT 0,
  attribution text NOT NULL DEFAULT 'click_id', require_click boolean NOT NULL DEFAULT true,
  window_hours int NOT NULL DEFAULT 72, dedupe boolean NOT NULL DEFAULT true,
  default_type text NOT NULL DEFAULT 'lead', default_revenue double precision NOT NULL DEFAULT 0,
  note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS geo_presets (
  id bigserial PRIMARY KEY, name text UNIQUE NOT NULL, countries jsonb NOT NULL DEFAULT '[]',
  builtin boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS ip_lists (
  id bigserial PRIMARY KEY, name text UNIQUE NOT NULL, kind text NOT NULL, url text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '', refresh_hours int NOT NULL DEFAULT 24, enabled boolean NOT NULL DEFAULT true,
  builtin boolean NOT NULL DEFAULT false, entries int NOT NULL DEFAULT 0, updated_at timestamptz,
  last_error text NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS integrations (
  id bigserial PRIMARY KEY, name text NOT NULL, kind text NOT NULL, enabled boolean NOT NULL DEFAULT true,
  url text NOT NULL, headers jsonb NOT NULL DEFAULT '{}', timeout_ms int NOT NULL DEFAULT 300,
  cache_minutes int NOT NULL DEFAULT 60, mapping jsonb NOT NULL DEFAULT '{}');
`

// migrations bring databases created by earlier versions up to date. Every
// statement is safe to run repeatedly.
const migrations = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS owner_id bigint REFERENCES users(id);
ALTER TABLE domains ADD COLUMN IF NOT EXISTS owner_id bigint REFERENCES users(id);
ALTER TABLE domain_groups ADD COLUMN IF NOT EXISTS owner_id bigint REFERENCES users(id);
ALTER TABLE whitepages ADD COLUMN IF NOT EXISTS owner_id bigint REFERENCES users(id);
ALTER TABLE conv_keys ADD COLUMN IF NOT EXISTS owner_id bigint REFERENCES users(id);
ALTER TABLE domain_groups DROP CONSTRAINT IF EXISTS domain_groups_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS domain_groups_owner_name ON domain_groups(owner_id, name);
CREATE TABLE IF NOT EXISTS campaign_shares (
  campaign_id bigint NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access text NOT NULL,
  PRIMARY KEY (campaign_id, user_id));
CREATE TABLE IF NOT EXISTS stream_presets (
  id bigserial PRIMARY KEY, owner_id bigint REFERENCES users(id), name text NOT NULL,
  kind text NOT NULL, data jsonb NOT NULL DEFAULT '{}');
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS stages jsonb NOT NULL DEFAULT '[]';
`

// OwnedTables are the tables whose rows belong to a user.
var OwnedTables = []string{"campaigns", "domains", "domain_groups", "whitepages", "conv_keys", "stream_presets"}

// AdoptOrphans makes sure there is an admin and that every row has an owner.
// Installations that predate multi-user support had neither.
func (s *Store) AdoptOrphans(ctx context.Context) error {
	if _, err := s.Pool.Exec(ctx, `UPDATE users SET role='admin' WHERE id=(SELECT min(id) FROM users)
		AND NOT EXISTS (SELECT 1 FROM users WHERE role='admin')`); err != nil {
		return err
	}
	for _, t := range OwnedTables {
		if _, err := s.Pool.Exec(ctx, "UPDATE "+t+" SET owner_id=(SELECT min(id) FROM users WHERE role='admin') WHERE owner_id IS NULL"); err != nil {
			return err
		}
	}
	return nil
}

// ---- generic CRUD over `db`-tagged structs ---------------------------------

// Columns the database fills in itself.
var generated = map[string]bool{"id": true, "created_at": true}

var rawJSON = reflect.TypeOf(json.RawMessage{})

func columns(v any) (cols []string, vals []any) {
	rv := reflect.Indirect(reflect.ValueOf(v))
	rt := rv.Type()
	for i := 0; i < rt.NumField(); i++ {
		tag := rt.Field(i).Tag.Get("db")
		if tag == "" || tag == "-" || generated[tag] {
			continue
		}
		f := rv.Field(i)
		val := f.Interface()
		// pgx sends nil slices/maps as SQL NULL; the jsonb columns are NOT NULL.
		switch {
		case f.Type() == rawJSON:
			if f.Len() == 0 {
				val = json.RawMessage("{}")
			}
		case f.Kind() == reflect.Slice && f.IsNil():
			val = reflect.MakeSlice(f.Type(), 0, 0).Interface()
		case f.Kind() == reflect.Map && f.IsNil():
			val = reflect.MakeMap(f.Type()).Interface()
		}
		cols = append(cols, tag)
		vals = append(vals, val)
	}
	return
}

func mapErr(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23505" {
		return ErrConflict
	}
	return err
}

func List[T any](ctx context.Context, s *Store, table, order string) ([]T, error) {
	rows, err := s.Pool.Query(ctx, "SELECT * FROM "+table+" ORDER BY "+order)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, pgx.RowToStructByName[T])
	if out == nil {
		out = []T{}
	}
	return out, err
}

func Get[T any](ctx context.Context, s *Store, table string, id int64) (*T, error) {
	rows, err := s.Pool.Query(ctx, "SELECT * FROM "+table+" WHERE id=$1", id)
	if err != nil {
		return nil, err
	}
	v, err := pgx.CollectExactlyOneRow(rows, pgx.RowToStructByName[T])
	if err != nil {
		return nil, mapErr(err)
	}
	return &v, nil
}

// Insert stores v and reloads it, so generated columns are populated.
func Insert[T any](ctx context.Context, s *Store, table string, v *T) error {
	cols, vals := columns(v)
	ph := make([]string, len(cols))
	for i := range cols {
		ph[i] = fmt.Sprintf("$%d", i+1)
	}
	q := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s) RETURNING *", table, strings.Join(cols, ","), strings.Join(ph, ","))
	rows, err := s.Pool.Query(ctx, q, vals...)
	if err != nil {
		return mapErr(err)
	}
	got, err := pgx.CollectExactlyOneRow(rows, pgx.RowToStructByName[T])
	if err != nil {
		return mapErr(err)
	}
	*v = got
	return nil
}

func Update[T any](ctx context.Context, s *Store, table string, id int64, v *T) error {
	cols, vals := columns(v)
	set := make([]string, len(cols))
	for i, c := range cols {
		set[i] = fmt.Sprintf("%s=$%d", c, i+1)
	}
	vals = append(vals, id)
	q := fmt.Sprintf("UPDATE %s SET %s WHERE id=$%d RETURNING *", table, strings.Join(set, ","), len(vals))
	rows, err := s.Pool.Query(ctx, q, vals...)
	if err != nil {
		return mapErr(err)
	}
	got, err := pgx.CollectExactlyOneRow(rows, pgx.RowToStructByName[T])
	if err != nil {
		return mapErr(err)
	}
	*v = got
	return nil
}

func (s *Store) Delete(ctx context.Context, table string, id int64) error {
	tag, err := s.Pool.Exec(ctx, "DELETE FROM "+table+" WHERE id=$1", id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- settings ---------------------------------------------------------------

func (s *Store) Settings(ctx context.Context) (model.Settings, error) {
	// Start from defaults so newly added fields get sane values.
	st := model.DefaultSettings()
	err := s.Pool.QueryRow(ctx, "SELECT value FROM settings WHERE key='main'").Scan(&st)
	if errors.Is(err, pgx.ErrNoRows) {
		return st, s.SaveSettings(ctx, st)
	}
	return st, err
}

func (s *Store) SaveSettings(ctx context.Context, st model.Settings) error {
	_, err := s.Pool.Exec(ctx, `INSERT INTO settings(key,value) VALUES('main',$1)
		ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, st)
	return err
}

// ---- users & sessions -------------------------------------------------------

func (s *Store) UserByName(ctx context.Context, name string) (*model.User, error) {
	rows, err := s.Pool.Query(ctx, "SELECT * FROM users WHERE username=$1", name)
	if err != nil {
		return nil, err
	}
	u, err := pgx.CollectExactlyOneRow(rows, pgx.RowToStructByName[model.User])
	if err != nil {
		return nil, mapErr(err)
	}
	return &u, nil
}

func (s *Store) CreateSession(ctx context.Context, hash string, userID int64, exp time.Time) error {
	_, err := s.Pool.Exec(ctx, "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)", hash, userID, exp)
	return err
}

func (s *Store) SessionUser(ctx context.Context, hash string) (*model.User, time.Time, error) {
	var uid int64
	var exp time.Time
	err := s.Pool.QueryRow(ctx, "SELECT user_id, expires_at FROM sessions WHERE token_hash=$1 AND expires_at>now()", hash).Scan(&uid, &exp)
	if err != nil {
		return nil, exp, mapErr(err)
	}
	u, err := Get[model.User](ctx, s, "users", uid)
	if err == nil && !u.Enabled {
		return nil, exp, ErrNotFound
	}
	return u, exp, err
}

func (s *Store) DeleteSession(ctx context.Context, hash string) {
	s.Pool.Exec(ctx, "DELETE FROM sessions WHERE token_hash=$1 OR expires_at<now()", hash)
}

// DeleteOtherSessions signs a user out everywhere except one session.
func (s *Store) DeleteOtherSessions(ctx context.Context, userID int64, keepHash string) {
	s.Pool.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2", userID, keepHash)
}

func (s *Store) DeleteUserSessions(ctx context.Context, userID int64) {
	s.Pool.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1", userID)
}

// ---- campaign shares --------------------------------------------------------

const shareSelect = `SELECT s.campaign_id, s.user_id, s.access, u.username
	FROM campaign_shares s JOIN users u ON u.id = s.user_id`

func (s *Store) shares(ctx context.Context, where string, args ...any) ([]model.Share, error) {
	rows, err := s.Pool.Query(ctx, shareSelect+where, args...)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, pgx.RowToStructByName[model.Share])
	if out == nil {
		out = []model.Share{}
	}
	return out, err
}

// Shares returns every share (for the runtime snapshot).
func (s *Store) Shares(ctx context.Context) ([]model.Share, error) { return s.shares(ctx, "") }

func (s *Store) CampaignShares(ctx context.Context, campaignID int64) ([]model.Share, error) {
	return s.shares(ctx, " WHERE s.campaign_id=$1 ORDER BY u.username", campaignID)
}

func (s *Store) UserShares(ctx context.Context, userID int64) ([]model.Share, error) {
	return s.shares(ctx, " WHERE s.user_id=$1", userID)
}

// SetShare grants, changes or (with an empty access) revokes a share.
func (s *Store) SetShare(ctx context.Context, campaignID, userID int64, access string) error {
	if access == "" {
		_, err := s.Pool.Exec(ctx, "DELETE FROM campaign_shares WHERE campaign_id=$1 AND user_id=$2", campaignID, userID)
		return err
	}
	_, err := s.Pool.Exec(ctx, `INSERT INTO campaign_shares(campaign_id,user_id,access) VALUES($1,$2,$3)
		ON CONFLICT (campaign_id,user_id) DO UPDATE SET access=EXCLUDED.access`, campaignID, userID, access)
	return mapErr(err)
}

// ---- domain helpers ---------------------------------------------------------

func (s *Store) SetDomainStatus(ctx context.Context, id int64, status, msg string) {
	s.Pool.Exec(ctx, "UPDATE domains SET status=$2, status_msg=$3, checked_at=now() WHERE id=$1", id, status, msg)
}

func (s *Store) SetListState(ctx context.Context, id int64, entries int, lastErr string) {
	s.Pool.Exec(ctx, "UPDATE ip_lists SET entries=$2, last_error=$3, updated_at=now() WHERE id=$1", id, entries, lastErr)
}
