package engine

import (
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
