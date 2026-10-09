package web

import (
	"context"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"simpletds/internal/model"
	"simpletds/internal/store"
)

// Campaign groups
//
// A group is a folder of its owner's campaigns. It never holds anybody else's:
// that is what makes sharing a group safe — the share covers exactly what the
// owner files under it, now and later, and nothing a third party could slip in.
//
//   - Only the owner (or an admin) creates, renames, shares and deletes a group.
//   - Only the campaign's owner (or an admin) moves it into or out of a group,
//     and only into a group of that same owner.
//   - A group share works like a campaign share at the same level on every
//     campaign of the group. Deleting the group, or taking a campaign out of
//     it, ends that access at once.

// checkCampaignGroup guards a change of a campaign's group.
func (s *Server) checkCampaignGroup(ctx context.Context, c *model.Campaign, old *model.Campaign) error {
	var before *int64
	if old != nil {
		before = old.GroupID
	}
	if (c.GroupID == nil && before == nil) || (c.GroupID != nil && before != nil && *c.GroupID == *before) {
		return nil
	}
	// Moving a campaign changes who can see it: that is the owner's call, not an editor's.
	if u := userFrom(ctx); old != nil && !u.IsAdmin() && old.OwnerID != u.ID {
		return &apiError{http.StatusForbidden, "only the owner can move a campaign to another group"}
	}
	if c.GroupID == nil {
		return nil
	}
	g, err := store.Get[model.CampaignGroup](ctx, s.st, "campaign_groups", *c.GroupID)
	if err != nil || g.OwnerID != c.OwnerID {
		return bad("group not found")
	}
	return nil
}

// visibleGroups lists the caller's own groups and the ones shared with them,
// each with the viewer's access level.
func (s *Server) visibleGroups(ctx context.Context, all []model.CampaignGroup) []model.CampaignGroup {
	u := userFrom(ctx)
	shared := map[int64]string{}
	if gs, err := s.st.UserGroupShares(ctx, u.ID); err == nil {
		for _, g := range gs {
			shared[g.GroupID] = g.Access
		}
	}
	names := map[int64]string{}
	if users, err := store.List[model.User](ctx, s.st, "users", "id"); err == nil {
		for _, x := range users {
			names[x.ID] = x.Username
		}
	}
	out := make([]model.CampaignGroup, 0, len(all))
	for _, g := range all {
		switch {
		case owns(u, &g):
			g.Access = model.AccessName(model.AccessOwner)
		case shared[g.ID] != "":
			g.Access = shared[g.ID]
		default:
			continue
		}
		g.OwnerName = names[g.OwnerID]
		out = append(out, g)
	}
	return out
}

func (s *Server) groupRoutes(r chi.Router) {
	mount(s, r, "/campaign-groups", resource[model.CampaignGroup]{table: "campaign_groups", order: "name, id",
		visible: s.visibleGroups,
		validate: func(_ context.Context, g *model.CampaignGroup, _ *model.CampaignGroup) error {
			g.Name = strings.TrimSpace(g.Name)
			switch {
			case g.Name == "":
				return bad("name is required")
			case len(g.Name) > 64:
				return bad("the name is too long")
			}
			return nil
		}})

	r.Get("/campaign-groups/{id}/shares", handler(func(r *http.Request) (any, error) {
		if _, err := ownedGet[model.CampaignGroup](r.Context(), s, "campaign_groups", pathID(r)); err != nil {
			return nil, err
		}
		return s.st.GroupShares(r.Context(), pathID(r))
	}))
	r.Put("/campaign-groups/{id}/shares", handler(func(r *http.Request) (any, error) {
		ctx := r.Context()
		g, err := ownedGet[model.CampaignGroup](ctx, s, "campaign_groups", pathID(r))
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
		if in.UserID == g.OwnerID {
			return nil, bad("the owner already has full access")
		}
		// Taking access away must work for a user who has since been disabled.
		if target, err := store.Get[model.User](ctx, s.st, "users", in.UserID); err != nil || (!target.Enabled && in.Access != "") {
			return nil, bad("user not found")
		}
		if err := s.st.SetGroupShare(ctx, g.ID, in.UserID, in.Access); err != nil {
			return nil, err
		}
		// Edit shares decide whose domains and keys may run the campaigns.
		if err := s.reload(ctx); err != nil {
			return nil, err
		}
		return s.st.GroupShares(ctx, g.ID)
	}))
}
