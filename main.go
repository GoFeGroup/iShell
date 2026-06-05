package main

import (
	"context"
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"ishell/backend"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := backend.NewApp()

	err := wails.Run(&options.App{
		Title:            "iShell",
		Width:            1280,
		Height:           800,
		MinWidth:         800,
		MinHeight:        500,
		StartHidden:      true,
		BackgroundColour: &options.RGBA{R: 21, G: 21, B: 31, A: 255},
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		OnStartup: app.Startup,
		OnDomReady: func(ctx context.Context) {
			wailsRuntime.WindowShow(ctx)
		},
		OnShutdown: app.Shutdown,
		Bind: []interface{}{
			app,
		},
		Mac: &mac.Options{
			Appearance:           mac.NSAppearanceNameDarkAqua,
			WebviewIsTransparent: true,
			WindowIsTranslucent:  false,
		},
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
			DisableWindowIcon:    false,
		},
		EnableDefaultContextMenu: false,
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
