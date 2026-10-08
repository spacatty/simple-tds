package web

import "embed"

// uiFS holds the built panel (web/ → internal/web/ui/dist).
//
//go:embed all:ui/dist
var uiFS embed.FS
