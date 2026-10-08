package web

import "embed"

// uiFS holds the built panel. `npm run build` in web/ writes it to ui/dist,
// which is not committed; without it the binary still builds and the panel
// URL answers 404.
//
//go:embed all:ui
var uiFS embed.FS
