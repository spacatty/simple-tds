package web

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"simpletds/internal/engine"
)

// The panel translates text that comes from the server (action and filter
// definitions, built-in presets) through web/src/i18n/ru.server.json. A label
// added here without a translation would silently stay English in the Russian
// panel, so the build fails instead.
func TestServerTextIsTranslated(t *testing.T) {
	raw, err := os.ReadFile("../../web/src/i18n/ru.server.json")
	if err != nil {
		t.Fatal(err)
	}
	var ru map[string]string
	if err := json.Unmarshal(raw, &ru); err != nil {
		t.Fatalf("ru.server.json: %v", err)
	}
	check := func(where, text string) {
		// Examples (a sample URL as a hint) are the same in every language.
		if text == "" || !strings.Contains(text, " ") && strings.ContainsAny(text, "/:.") {
			return
		}
		if ru[text] == "" {
			t.Errorf("%s: %q has no translation in web/src/i18n/ru.server.json", where, text)
		}
	}
	for _, a := range engine.ActionDefs() {
		check("action "+a.Type, a.Label)
		check("action "+a.Type, a.Description)
		for _, f := range a.Fields {
			check("action "+a.Type+" field "+f.Name, f.Label)
			check("action "+a.Type+" field "+f.Name, f.Help)
		}
	}
	for _, f := range engine.FilterDefs() {
		check("filter "+f.Type, f.Label)
		check("filter "+f.Type, f.Group)
		check("filter "+f.Type, f.Help)
	}
	for _, p := range (*engine.ParamNames)(nil).Defs() {
		check("system parameter "+p.Name, p.Group)
		check("system parameter "+p.Name, p.Label)
	}
	for _, p := range builtinPresets {
		check("stream preset", p.Name)
	}
	for _, p := range integrationPresets {
		check("integration preset "+p.Name, p.Description)
	}
}
