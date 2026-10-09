package engine

import (
	"net/url"
	"reflect"
	"testing"

	"simpletds/internal/model"
)

func testLanding() *model.Landing {
	return &model.Landing{ID: 7, Key: "abc", Vars: []model.LandingVar{
		{Name: "TITLE", Kind: model.VarText, Default: "Default"},
		{Name: "BLOCK", Kind: model.VarHTML},
		{Name: "LINK", Kind: model.VarURL},
		{Name: "NAME", Kind: model.VarJS},
		{Name: "DSN", Kind: model.VarServer, Default: "pg://default"},
	}, Presets: []model.LandingPreset{
		{ID: 1, Name: "prod", Values: map[string]string{"TITLE": "Prod", "DSN": "pg://prod"}},
		{ID: 2, Name: "staging", Values: map[string]string{"BLOCK": "{event:view}"}},
	}}
}

// A variable takes the stream's value, else the preset's, else its default.
func TestLandingValuePrecedence(t *testing.T) {
	l := testLanding()
	cfg := &LandingConfig{Values: map[string]string{"DSN": "pg://stream"}}
	got := cfg.rawValues(l, 1)
	want := map[string]string{"TITLE": "Prod", "BLOCK": "", "LINK": "", "NAME": "", "DSN": "pg://stream"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("preset 1: got %v, want %v", got, want)
	}
	if got := cfg.rawValues(l, 0)["TITLE"]; got != "Default" {
		t.Fatalf("no preset: TITLE = %q, want the default", got)
	}
	if got := cfg.rawValues(l, 99)["TITLE"]; got != "Default" {
		t.Fatalf("a preset that is gone must fall back to the default, got %q", got)
	}
}

// Each kind of variable is escaped for the place it goes to, and a server-only
// variable never reaches the page.
func TestLandingValuesAreEscaped(t *testing.T) {
	l := testLanding()
	v := &Visit{Campaign: &CampaignRT{}, params: NewParamNames(nil), ClickID: "CLICK",
		Query: url.Values{"keyword": {`<b>"x"</b> & y`}}}
	cfg := &LandingConfig{Values: map[string]string{
		"TITLE": "<i>{keyword}</i>",
		"BLOCK": "<i>{keyword}</i>",
		"LINK":  `https://x.example/?k={keyword}&a="b"`,
		"NAME":  `a"b</script>'{keyword}`,
	}}
	vals := (&Engine{}).landingValues(v, l, cfg, 0)
	want := map[string]string{
		"TITLE": "&lt;i&gt;&lt;b&gt;&#34;x&#34;&lt;/b&gt; &amp; y&lt;/i&gt;",
		"BLOCK": "<i>&lt;b&gt;&#34;x&#34;&lt;/b&gt; &amp; y</i>",
		"LINK":  "https://x.example/?k=%3Cb%3E%22x%22%3C%2Fb%3E+%26+y&a=%22b%22",
		"NAME":  `a\"b\u003c/script\u003e\u0027\u003cb\u003e\"x\"\u003c/b\u003e \u0026 y`,
	}
	if !reflect.DeepEqual(vals.Out, want) {
		t.Fatalf("got\n%#v\nwant\n%#v", vals.Out, want)
	}
	if vals.Env[model.LandingVarPrefix+"DSN"] != "pg://default" || vals.Env["TDS_CLICK_ID"] != "CLICK" {
		t.Fatalf("PHP must get every variable and the click id: %v", vals.Env)
	}
	if got := vals.Env[model.LandingVarPrefix+"NAME"]; got != `a"b</script>'<b>"x"</b> & y` {
		t.Fatalf("PHP gets values unescaped, got %q", got)
	}
}

// Without its click a landing page reports nothing and links nowhere.
func TestLandingBlankVisit(t *testing.T) {
	l := testLanding()
	v := &Visit{Campaign: &CampaignRT{}, params: NewParamNames(nil), Query: url.Values{}, blank: true}
	cfg := &LandingConfig{Values: map[string]string{"LINK": "{offer}", "BLOCK": "[{event:view}]", "TITLE": "{sub1}|{unknown}"}}
	vals := (&Engine{}).landingValues(v, l, cfg, 0)
	if vals.Out["LINK"] != "" || vals.Out["BLOCK"] != "[]" || vals.Out["TITLE"] != "|{unknown}" {
		t.Fatalf("got %#v", vals.Out)
	}
}

func TestLandingStageRefs(t *testing.T) {
	l := testLanding()
	cfg := &LandingConfig{Presets: []LandingSplit{{ID: 1, Weight: 1}, {ID: 2, Weight: 1}},
		Values: map[string]string{"LINK": "{event:Lead}?x=1"}, OfferURL: "https://o.example/", OfferStage: "cta"}
	got := cfg.StageRefs(l)
	want := []StageRef{{"LINK", "lead"}, {"BLOCK", "view"}, {"", "cta"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	// A value the stream overrides is not what visitors get: its stage does not count.
	cfg.Values["BLOCK"] = "plain"
	if got := cfg.StageRefs(l); !reflect.DeepEqual(got, []StageRef{{"LINK", "lead"}, {"", "cta"}}) {
		t.Fatalf("overridden preset value still counted: %v", got)
	}
}

func TestLandingPick(t *testing.T) {
	if got := (&LandingConfig{}).pick(); got != 0 {
		t.Fatalf("no presets: got %d", got)
	}
	if got := (&LandingConfig{Presets: []LandingSplit{{ID: 3}, {ID: 4}}}).pick(); got != 3 {
		t.Fatalf("all weights zero: got %d, want the first", got)
	}
	seen := map[int64]int{}
	cfg := &LandingConfig{Presets: []LandingSplit{{ID: 1, Weight: 1}, {ID: 2, Weight: 0}, {ID: 3, Weight: 1}}}
	for i := 0; i < 400; i++ {
		seen[cfg.pick()]++
	}
	if seen[1] == 0 || seen[3] == 0 || seen[2] != 0 || len(seen) != 2 {
		t.Fatalf("split went wrong: %v", seen)
	}
}

// The cookie is bound to its landing and cannot be edited.
func TestLandingCookie(t *testing.T) {
	e := &Engine{secret: []byte("secret")}
	l := testLanding()
	in := &landingCtx{Click: "abc", Stream: 5, Preset: 2, Referer: "https://r.example/", Query: "sub1=a&keyword=b"}
	cookie := e.signLanding(l, in)
	if got := e.readLanding(l, cookie); got == nil || *got != *in {
		t.Fatalf("round trip: got %+v", got)
	}
	if e.readLanding(l, cookie[:len(cookie)-1]+"A") != nil && cookie[len(cookie)-1] != 'A' {
		t.Fatal("a cookie with a wrong signature was accepted")
	}
	if e.readLanding(&model.Landing{Key: "other"}, cookie) != nil {
		t.Fatal("a cookie of another landing was accepted")
	}
	if e.readLanding(l, "") != nil || e.readLanding(l, "garbage") != nil {
		t.Fatal("garbage was accepted")
	}
}

func TestClipQuery(t *testing.T) {
	if got := clipQuery("a=1&b=2&c=3", 8); got != "a=1&b=2&" {
		t.Fatalf("got %q", got)
	}
	if got := clipQuery("abcdefghij", 5); got != "" {
		t.Fatalf("one long parameter must be dropped whole, got %q", got)
	}
	if got := clipQuery("a=1", 8); got != "a=1" {
		t.Fatalf("got %q", got)
	}
}
