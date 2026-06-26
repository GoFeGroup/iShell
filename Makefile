APP_NAME := iShell
BUILD_DIR := build/bin
VERSION   := $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS   := -X ishell/backend.Version=$(VERSION)

.PHONY: all dev build build-mac build-mac-arm64 build-mac-amd64 build-windows clean

all: build

## 开发模式（热重载）
dev:
	wails dev

## 构建当前平台
build:
	wails build -ldflags "$(LDFLAGS)"

## 构建 macOS ARM64 (Apple Silicon)
build-mac-arm64:
	wails build -platform darwin/arm64 -ldflags "$(LDFLAGS)"
	@echo "=> $(BUILD_DIR)/$(APP_NAME).app (arm64)"

## 构建 macOS AMD64 (Intel)
build-mac-amd64:
	wails build -platform darwin/amd64 -ldflags "$(LDFLAGS)"
	@echo "=> $(BUILD_DIR)/$(APP_NAME).app (amd64)"

## 构建 macOS Universal Binary (需要在 macOS 上执行)
build-mac: build-mac-arm64
	@mkdir -p $(BUILD_DIR)/universal
	wails build -platform darwin/amd64 -ldflags "$(LDFLAGS)" -o $(APP_NAME)-amd64
	lipo -create -output $(BUILD_DIR)/$(APP_NAME)-universal \
		$(BUILD_DIR)/$(APP_NAME) \
		$(BUILD_DIR)/$(APP_NAME)-amd64
	@echo "=> $(BUILD_DIR)/$(APP_NAME)-universal"

## 构建 Windows AMD64
build-windows:
	wails build -platform windows/amd64 -ldflags "$(LDFLAGS)"
	@echo "=> $(BUILD_DIR)/$(APP_NAME).exe"

## 构建 Windows 安装包 .exe（需要安装 nsis: brew install nsis）
build-windows-installer:
	wails build -platform windows/amd64 -nsis -ldflags "$(LDFLAGS)"
	@echo "=> $(BUILD_DIR)/$(APP_NAME)-amd64-installer.exe"

## 构建所有平台
build-all: build-mac-arm64 build-windows

clean:
	rm -rf $(BUILD_DIR)
