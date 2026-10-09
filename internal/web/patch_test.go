package web

import (
	"net/http/httptest"
	"strings"
	"testing"

	"simpletds/internal/model"
)

// A PUT decodes over a copy of the stored row. The stored row must come out
// untouched, or the checks that compare old and new (who may move a campaign
// to another group, which campaign a domain may serve) see no change at all.
func TestReadPatchLeavesStoredRowAlone(t *testing.T) {
	one, two := int64(1), int64(2)
	old := model.Campaign{Name: "a", GroupID: &one, Stages: []model.Stage{{Key: "lead"}}}

	v := old
	r := httptest.NewRequest("PUT", "/", strings.NewReader(`{"group_id":2,"stages":[{"key":"sale"}]}`))
	if err := readPatch(r, &v); err != nil {
		t.Fatal(err)
	}
	if v.GroupID == nil || *v.GroupID != two || v.Stages[0].Key != "sale" {
		t.Fatalf("patch not applied: %+v", v)
	}
	if *old.GroupID != one || old.Stages[0].Key != "lead" {
		t.Fatalf("stored row changed: group %d, stage %q", *old.GroupID, old.Stages[0].Key)
	}
	if v.Name != "a" {
		t.Errorf("omitted field lost: %q", v.Name)
	}

	v = old
	r = httptest.NewRequest("PUT", "/", strings.NewReader(`{"group_id":null}`))
	if err := readPatch(r, &v); err != nil {
		t.Fatal(err)
	}
	if v.GroupID != nil || old.GroupID == nil {
		t.Errorf("null must clear the copy only: new %v, old %v", v.GroupID, old.GroupID)
	}
}

func TestValidateDashboard(t *testing.T) {
	d := model.Dashboard{Name: " board ", Widgets: []model.DashWidget{{Type: "stat", Metric: "clicks"}, {ID: "x", Type: "funnel", W: 99, H: 5000}, {ID: "x", Type: "top", Dim: "country", W: 4}}}
	if err := validateDashboard(&d); err != nil {
		t.Fatal(err)
	}
	if d.Name != "board" || d.Widgets[0].W != 3 || d.Widgets[1].W != 6 || d.Widgets[0].H != 0 || d.Widgets[1].H != maxDashHeight || d.Widgets[0].ID == "" || d.Widgets[2].ID == "x" {
		t.Errorf("not normalised: %+v", d)
	}
	for _, bad := range []model.Dashboard{
		{Name: ""},
		{Name: "a", Widgets: []model.DashWidget{{Type: "iframe"}}},
		{Name: "a", Widgets: []model.DashWidget{{Type: "stat", Metric: "clicks; drop"}}},
		{Name: "a", Widgets: make([]model.DashWidget, maxDashWidgets+1)},
	} {
		if validateDashboard(&bad) == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
}
