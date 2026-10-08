package web

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/bcrypt"

	"simpletds/internal/events"
	"simpletds/internal/model"
	"simpletds/internal/store"
)

// Access model
//
//   - Admins manage users and global settings and can see and change everything.
//   - Everything else (campaigns, domains, groups, whitepages, conversion keys)
//     belongs to the user who created it and is invisible to other users.
//   - A campaign can be shared with other users at one of three levels:
//     stats (reports only), read (plus configuration, read-only) or edit.
//
// Resources a user may not see answer 404, never 403, so their existence
// does not leak.

func userFrom(ctx context.Context) *model.User {
	u, _ := ctx.Value(userKey{}).(*model.User)
	return u
}

func (s *Server) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !currentUser(r).IsAdmin() {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "administrators only"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// owns reports whether u may manage an owned entity.
func owns(u *model.User, v any) bool {
	if u.IsAdmin() {
		return true
	}
	o, ok := v.(model.Owned)
	return ok && o.Owner() == u.ID
}

// ownedGet loads a row and hides it from anyone but its owner and admins.
func ownedGet[T any](ctx context.Context, s *Server, table string, id int64) (*T, error) {
	v, err := store.Get[T](ctx, s.st, table, id)
	if err != nil {
		return nil, err
	}
	if !owns(userFrom(ctx), v) {
		return nil, store.ErrNotFound
	}
	return v, nil
}

func visibleOwned[T any](ctx context.Context, items []T) []T {
	u := userFrom(ctx)
	out := make([]T, 0, len(items))
	for i := range items {
		if owns(u, &items[i]) {
			out = append(out, items[i])
		}
	}
	return out
}

// shareMap returns the user's shared campaigns and their access level.
func (s *Server) shareMap(ctx context.Context, u *model.User) (map[int64]int, error) {
	shares, err := s.st.UserShares(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	m := make(map[int64]int, len(shares))
	for _, sh := range shares {
		m[sh.CampaignID], _ = model.ParseAccess(sh.Access)
	}
	return m, nil
}

func accessOf(u *model.User, c *model.Campaign, shares map[int64]int) int {
	if u.IsAdmin() || c.OwnerID == u.ID {
		return model.AccessOwner
	}
	return shares[c.ID]
}

// campaign loads a campaign the current user holds at least `min` access to.
func (s *Server) campaign(ctx context.Context, id int64, min int) (*model.Campaign, error) {
	c, err := store.Get[model.Campaign](ctx, s.st, "campaigns", id)
	if err != nil {
		return nil, err
	}
	u := userFrom(ctx)
	shares, err := s.shareMap(ctx, u)
	if err != nil {
		return nil, err
	}
	switch a := accessOf(u, c, shares); {
	case a == model.AccessNone:
		return nil, store.ErrNotFound
	case a < min:
		return nil, &apiError{http.StatusForbidden, "this needs " + model.AccessName(min) + " access to the campaign; yours is " + model.AccessName(a)}
	}
	return c, nil
}

// visibleCampaigns filters to what the user may see and annotates each
// campaign with the viewer's access level.
func (s *Server) visibleCampaigns(ctx context.Context, all []model.Campaign) []model.Campaign {
	u := userFrom(ctx)
	shares, _ := s.shareMap(ctx, u)
	names := map[int64]string{}
	if users, err := store.List[model.User](ctx, s.st, "users", "id"); err == nil {
		for _, x := range users {
			names[x.ID] = x.Username
		}
	}
	out := make([]model.Campaign, 0, len(all))
	for _, c := range all {
		a := accessOf(u, &c, shares)
		if a == model.AccessNone {
			continue
		}
		c.Access, c.OwnerName = model.AccessName(a), names[c.OwnerID]
		if a < model.AccessEdit {
			c.Token = "" // the integration secret is for editors only
		}
		out = append(out, c)
	}
	return out
}

// scope restricts a report or log query to the campaigns and keys the
// current user may see. Admins are unrestricted.
func (s *Server) scope(ctx context.Context, q *events.Query) error {
	u := userFrom(ctx)
	if u.IsAdmin() {
		return nil
	}
	q.Scoped = true
	all, err := store.List[model.Campaign](ctx, s.st, "campaigns", "id")
	if err != nil {
		return err
	}
	for _, c := range s.visibleCampaigns(ctx, all) {
		q.Campaigns = append(q.Campaigns, uint32(c.ID))
	}
	keys, err := store.List[model.ConvKey](ctx, s.st, "conv_keys", "id")
	if err != nil {
		return err
	}
	for _, k := range keys {
		if k.OwnerID == u.ID {
			q.Keys = append(q.Keys, uint32(k.ID))
		}
	}
	return nil
}

// checkActionRefs makes sure a stream only points at whitepages and
// campaigns its editor is entitled to use. References that were already in
// place are left alone, so an editor can save a stream the owner configured.
func (s *Server) checkActionRefs(ctx context.Context, st *model.Stream, old *model.Stream) error {
	type refs struct {
		Whitepage int64 `json:"whitepage_id"`
		Campaign  int64 `json:"campaign_id"`
	}
	var now, before refs
	json.Unmarshal(st.ActionConfig, &now)
	if old != nil && old.ActionType == st.ActionType {
		json.Unmarshal(old.ActionConfig, &before)
	}
	u := userFrom(ctx)
	if st.ActionType == "whitepage" && now.Whitepage != 0 && now.Whitepage != before.Whitepage {
		wp, err := store.Get[model.Whitepage](ctx, s.st, "whitepages", now.Whitepage)
		if err != nil {
			return bad("whitepage not found")
		}
		owner, err := store.Get[model.Campaign](ctx, s.st, "campaigns", st.CampaignID)
		if err != nil {
			return err
		}
		if !owns(u, wp) && wp.OwnerID != owner.OwnerID {
			return bad("whitepage not found")
		}
	}
	if st.ActionType == "campaign" && now.Campaign != 0 && now.Campaign != before.Campaign {
		if _, err := s.campaign(ctx, now.Campaign, model.AccessEdit); err != nil {
			return bad("target campaign not found or not editable by you")
		}
	}
	return nil
}

// ---- user management --------------------------------------------------------

var reUsername = regexp.MustCompile(`^[A-Za-z0-9._-]{3,32}$`)

type userInput struct {
	Username *string `json:"username"`
	Password *string `json:"password"`
	Role     *string `json:"role"`
	Enabled  *bool   `json:"enabled"`
}

func hashPassword(p string) (string, error) {
	if len(p) < 10 {
		return "", bad("password must be at least 10 characters")
	}
	h, err := bcrypt.GenerateFromPassword([]byte(p), 12)
	return string(h), err
}

// otherAdmins counts enabled admins besides the given user.
func (s *Server) otherAdmins(ctx context.Context, except int64) (int, error) {
	var n int
	err := s.st.Pool.QueryRow(ctx, "SELECT count(*) FROM users WHERE role='admin' AND enabled AND id<>$1", except).Scan(&n)
	return n, err
}

func (s *Server) userRoutes(r chi.Router) {
	// Any signed-in user may look up names to share a campaign with.
	r.Get("/users/directory", handler(func(r *http.Request) (any, error) {
		users, err := store.List[model.User](r.Context(), s.st, "users", "username")
		if err != nil {
			return nil, err
		}
		type entry struct {
			ID       int64  `json:"id"`
			Username string `json:"username"`
		}
		out := []entry{}
		for _, u := range users {
			if u.Enabled {
				out = append(out, entry{u.ID, u.Username})
			}
		}
		return out, nil
	}))

	r.Get("/campaigns/{id}/shares", handler(func(r *http.Request) (any, error) {
		if _, err := s.campaign(r.Context(), pathID(r), model.AccessOwner); err != nil {
			return nil, err
		}
		return s.st.CampaignShares(r.Context(), pathID(r))
	}))
	r.Put("/campaigns/{id}/shares", handler(func(r *http.Request) (any, error) {
		ctx := r.Context()
		c, err := s.campaign(ctx, pathID(r), model.AccessOwner)
		if err != nil {
			return nil, err
		}
		var in struct {
			UserID int64  `json:"user_id"`
			Access string `json:"access"` // stats | read | edit | none
		}
		if err := readJSON(r, &in); err != nil {
			return nil, err
		}
		if in.Access == "none" {
			in.Access = ""
		}
		if _, ok := model.ParseAccess(in.Access); !ok && in.Access != "" {
			return nil, bad("access must be stats, read, edit or none")
		}
		if in.UserID == c.OwnerID {
			return nil, bad("the owner already has full access")
		}
		if target, err := store.Get[model.User](ctx, s.st, "users", in.UserID); err != nil || !target.Enabled {
			return nil, bad("user not found")
		}
		if err := s.st.SetShare(ctx, c.ID, in.UserID, in.Access); err != nil {
			return nil, err
		}
		if err := s.reload(ctx); err != nil {
			return nil, err
		}
		return s.st.CampaignShares(ctx, c.ID)
	}))

	r.Group(func(r chi.Router) {
		r.Use(s.requireAdmin)
		r.Get("/users", handler(func(r *http.Request) (any, error) {
			return store.List[model.User](r.Context(), s.st, "users", "id")
		}))
		r.Post("/users", handler(s.userCreate))
		r.Put("/users/{id}", handler(s.userUpdate))
		r.Delete("/users/{id}", handler(s.userDelete))
	})
}

func (s *Server) userCreate(r *http.Request) (any, error) {
	var in userInput
	if err := readJSON(r, &in); err != nil {
		return nil, err
	}
	u := model.User{Role: model.RoleUser, Enabled: true}
	if in.Username != nil {
		u.Username = strings.TrimSpace(*in.Username)
	}
	if !reUsername.MatchString(u.Username) {
		return nil, bad("username: 3-32 letters, digits, dot, dash or underscore")
	}
	if in.Role != nil {
		u.Role = *in.Role
	}
	if !oneOf(u.Role, model.RoleAdmin, model.RoleUser) {
		return nil, bad("role must be admin or user")
	}
	if in.Password == nil {
		return nil, bad("password is required")
	}
	var err error
	if u.PasswordHash, err = hashPassword(*in.Password); err != nil {
		return nil, err
	}
	if err := store.Insert(r.Context(), s.st, "users", &u); err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *Server) userUpdate(r *http.Request) (any, error) {
	ctx := r.Context()
	u, err := store.Get[model.User](ctx, s.st, "users", pathID(r))
	if err != nil {
		return nil, err
	}
	var in userInput
	if err := readJSON(r, &in); err != nil {
		return nil, err
	}
	wasAdmin := u.IsAdmin() && u.Enabled
	if in.Role != nil {
		if !oneOf(*in.Role, model.RoleAdmin, model.RoleUser) {
			return nil, bad("role must be admin or user")
		}
		u.Role = *in.Role
	}
	if in.Enabled != nil {
		u.Enabled = *in.Enabled
	}
	if wasAdmin && !(u.IsAdmin() && u.Enabled) {
		if n, err := s.otherAdmins(ctx, u.ID); err != nil {
			return nil, err
		} else if n == 0 {
			return nil, conflict("this is the last active administrator")
		}
	}
	if in.Password != nil && *in.Password != "" {
		if u.PasswordHash, err = hashPassword(*in.Password); err != nil {
			return nil, err
		}
		s.st.DeleteUserSessions(ctx, u.ID)
	}
	if !u.Enabled {
		s.st.DeleteUserSessions(ctx, u.ID)
	}
	if err := store.Update(ctx, s.st, "users", u.ID, u); err != nil {
		return nil, err
	}
	s.dropSessions()
	return u, nil
}

// userDelete removes a user. Whatever they owned is handed to the admin
// doing the deletion, so live campaigns and domains keep working.
func (s *Server) userDelete(r *http.Request) (any, error) {
	ctx := r.Context()
	me := currentUser(r)
	u, err := store.Get[model.User](ctx, s.st, "users", pathID(r))
	if err != nil {
		return nil, err
	}
	if u.ID == me.ID {
		return nil, bad("you cannot delete your own account")
	}
	if u.IsAdmin() && u.Enabled {
		if n, err := s.otherAdmins(ctx, u.ID); err != nil {
			return nil, err
		} else if n == 0 {
			return nil, conflict("this is the last active administrator")
		}
	}
	tx, err := s.st.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// Group names are unique per owner: tag inherited ones to avoid a clash.
	if _, err := tx.Exec(ctx, "UPDATE domain_groups SET name = name || ' (' || $2 || ')' WHERE owner_id=$1", u.ID, u.Username); err != nil {
		return nil, err
	}
	for _, t := range store.OwnedTables {
		if _, err := tx.Exec(ctx, "UPDATE "+t+" SET owner_id=$2 WHERE owner_id=$1", u.ID, me.ID); err != nil {
			return nil, err
		}
	}
	// The new owner needs no share on what is now their own campaign.
	if _, err := tx.Exec(ctx, `DELETE FROM campaign_shares s USING campaigns c
		WHERE c.id = s.campaign_id AND c.owner_id = s.user_id`); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM users WHERE id=$1", u.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	s.dropSessions()
	return nil, s.reload(ctx)
}
