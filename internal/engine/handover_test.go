package engine

import (
	"errors"
	"testing"

	"simpletds/internal/model"
)

func TestHandOverFunnel(t *testing.T) {
	stages := []model.Stage{{Key: "reg", Name: "Registration"}, {Key: "ftd", Name: "Deposit", Goal: true}}
	camp := func(id, owner int64, st []model.Stage) *CampaignRT {
		return &CampaignRT{Campaign: model.Campaign{ID: id, OwnerID: owner, Stages: st}, users: map[int64]bool{owner: true}}
	}
	main := camp(1, 10, stages)
	src := camp(2, 10, nil)
	own := camp(3, 10, []model.Stage{{Key: "lead", Name: "Lead", Goal: true}})
	foreign := camp(4, 20, stages)
	bare := camp(5, 10, nil)
	s := &Snapshot{ByID: map[int64]*CampaignRT{1: main, 2: src, 3: own, 4: foreign, 5: bare},
		// Streams 21 and 22 of the source, 31 of the campaign with its own
		// funnel, 41 sends the source's traffic to someone else's campaign.
		handOver:  map[int64]int64{21: 1, 22: 5, 31: 1, 41: 4},
		handOrder: map[int64][]int64{2: {22, 21}, 3: {31}},
	}

	cases := []struct {
		name   string
		c      *CampaignRT
		stream int64
		want   *CampaignRT
	}{
		{"hand-over stream takes the target's funnel", src, 21, main},
		{"a target without stages leaves the source's", src, 22, src},
		{"another stream of the source", src, 99, src},
		{"the hand-over wins over the source's own funnel", own, 31, main},
		{"a campaign the owner may not run lends nothing", src, 41, src},
	}
	for _, tc := range cases {
		if got := s.FunnelOf(tc.c, tc.stream); got != tc.want {
			t.Errorf("%s: got campaign %d, want %d", tc.name, got.ID, tc.want.ID)
		}
	}

	// The report shows a campaign's own funnel, else the first one it hands to.
	if f := s.ReportFunnel(src); f != main {
		t.Errorf("report funnel of a source: %v", f)
	}
	if f := s.ReportFunnel(own); f != own {
		t.Errorf("report funnel of a campaign with stages: %v", f)
	}
	if f := s.ReportFunnel(bare); f != nil {
		t.Errorf("report funnel of a campaign without any: %v", f)
	}
}

func TestHandOverJSCheck(t *testing.T) {
	served := func(*Visit) (*Result, error) { return &Result{Status: 200}, nil }
	offer := &StreamRT{Stream: model.Stream{ID: 11, JSCheck: true}, action: served}
	target := &CampaignRT{Campaign: model.Campaign{ID: 1, OwnerID: 10, Enabled: true}, Regular: []*StreamRT{offer},
		users: map[int64]bool{10: true}}
	src := &CampaignRT{Campaign: model.Campaign{ID: 2, OwnerID: 10, Enabled: true}, users: map[int64]bool{10: true}}
	e := &Engine{}
	e.snap.Store(&Snapshot{ByID: map[int64]*CampaignRT{1: target, 2: src}, handOver: map[int64]int64{21: 1}})
	h, err := buildAction(HandOverAction, []byte(`{"campaign_id":1}`), e)
	if err != nil {
		t.Fatal(err)
	}
	hand := func(canChallenge bool) (*Visit, *Result, error) {
		v := &Visit{Campaign: src, Stream: &StreamRT{Stream: model.Stream{ID: 21}}, canChallenge: canChallenge}
		res, err := h(v)
		return v, res, err
	}

	if _, _, err := hand(true); !errors.Is(err, errNeedJSCheck) {
		t.Errorf("a browser that has not passed: got %v, want the JS check", err)
	}
	if v, res, err := hand(false); err != nil || res.Status != 200 || v.ServedStream != 11 {
		t.Errorf("a browser that passed: %v %v, served stream %d", res, err, v.ServedStream)
	}
	offer.JSCheck = false
	if _, res, err := hand(true); err != nil || res.Status != 200 {
		t.Errorf("a target stream without the check: %v %v", res, err)
	}
}
