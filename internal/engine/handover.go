package engine

import (
	"encoding/json"
	"errors"
)

// errNeedJSCheck is how a hand-over asks Process for the JS check page: the
// stream it chose in the target campaign runs the check, and this browser
// has not passed it yet.
var errNeedJSCheck = errors.New("the JS check comes first")

// A "Send to campaign" stream lets one campaign serve visits that came to
// another: sources each have a campaign of their own, and all of them hand
// their traffic to one campaign that holds the offers and the funnel. The
// click and everything it converts stay with the source, which keeps its own
// cost; the funnel the conversions are checked against is the one of the
// campaign that served the visit, so the sources need no copy of it.

// HandOverAction is the stream action that hands a visit to another campaign.
const HandOverAction = "campaign"

// handOverTarget reads the campaign a hand-over stream sends visits to.
func handOverTarget(cfg json.RawMessage) int64 {
	var c struct {
		ID int64 `json:"campaign_id"`
	}
	if json.Unmarshal(cfg, &c) != nil {
		return 0
	}
	return c.ID
}

// funnelTarget is the campaign whose funnel a hand-over stream's clicks
// convert through: its target, when that has stages and the source's owner
// may run it. Nil otherwise.
func (s *Snapshot) funnelTarget(c *CampaignRT, streamID int64) *CampaignRT {
	id, ok := s.handOver[streamID]
	if !ok {
		return nil
	}
	t := s.ByID[id]
	if t == nil || len(t.Stages) == 0 || !t.UsableBy(c.OwnerID) {
		return nil
	}
	return t
}

// FunnelOf returns the campaign whose stages apply to a click of campaign c
// routed by the given stream: the target of a hand-over stream, otherwise c.
func (s *Snapshot) FunnelOf(c *CampaignRT, streamID int64) *CampaignRT {
	if t := s.funnelTarget(c, streamID); t != nil {
		return t
	}
	return c
}

// ReportFunnel returns the campaign whose stages a funnel report of c shows:
// c itself when it has a funnel, otherwise the first campaign it hands visits
// to that has one. Nil when neither does.
func (s *Snapshot) ReportFunnel(c *CampaignRT) *CampaignRT {
	if len(c.Stages) > 0 {
		return c
	}
	for _, id := range s.handOrder[c.ID] {
		if t := s.funnelTarget(c, id); t != nil {
			return t
		}
	}
	return nil
}

// stages is the campaign whose funnel applies to the visit.
func (v *Visit) stages() *CampaignRT {
	if v.funnel != nil {
		return v.funnel
	}
	return v.Campaign
}
