package ai

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNormalizeOpenURLAddsHTTPSForBareDomains(t *testing.T) {
	u, err := normalizeOpenURL("example.com/path?q=1")
	if err != nil {
		t.Fatalf("normalizeOpenURL: %v", err)
	}
	if got := u.String(); got != "https://example.com/path?q=1" {
		t.Fatalf("URL = %q, want https URL", got)
	}
}

func TestNormalizeOpenURLRejectsUnsupportedSchemes(t *testing.T) {
	for _, raw := range []string{"file:///etc/passwd", "ftp://example.com/file"} {
		if _, err := normalizeOpenURL(raw); err == nil {
			t.Fatalf("normalizeOpenURL(%q) returned nil error", raw)
		}
	}
}

func TestOpenURLExtractsHTMLText(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<!doctype html>
			<html>
				<head>
					<title>Example Page</title>
					<style>.hidden{display:none}</style>
					<script>window.secret = "nope"</script>
				</head>
				<body><h1>Hello</h1><p>Visible text.</p><noscript>noscript text</noscript></body>
			</html>`))
	}))
	defer srv.Close()

	out, err := openURL(context.Background(), srv.URL)
	if err != nil {
		t.Fatalf("openURL: %v", err)
	}
	for _, want := range []string{"Title: Example Page", "Hello", "Visible text."} {
		if !strings.Contains(out, want) {
			t.Fatalf("output missing %q:\n%s", want, out)
		}
	}
	for _, banned := range []string{"window.secret", ".hidden", "noscript text"} {
		if strings.Contains(out, banned) {
			t.Fatalf("output should not include %q:\n%s", banned, out)
		}
	}
}

func TestOpenURLTruncatesLargeResponses(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte(strings.Repeat("x", maxWebReadContentLen*2)))
	}))
	defer srv.Close()

	out, err := openURL(context.Background(), srv.URL)
	if err != nil {
		t.Fatalf("openURL: %v", err)
	}
	if !strings.Contains(out, webReadTruncation) || !strings.Contains(out, "Note: response content was truncated.") {
		t.Fatalf("output should be truncated:\n%s", out)
	}
}

func TestOpenURLReturnsHTTPStatusErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "missing page", http.StatusNotFound)
	}))
	defer srv.Close()

	_, err := openURL(context.Background(), srv.URL)
	if err == nil {
		t.Fatal("openURL returned nil error for non-2xx response")
	}
	if !strings.Contains(fmt.Sprint(err), "404") || !strings.Contains(fmt.Sprint(err), "missing page") {
		t.Fatalf("error = %v, want status and body", err)
	}
}

func TestOpenURLRejectsBinaryContent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write([]byte{0, 1, 2, 3})
	}))
	defer srv.Close()

	_, err := openURL(context.Background(), srv.URL)
	if err == nil {
		t.Fatal("openURL returned nil error for binary content")
	}
	if !strings.Contains(fmt.Sprint(err), "unsupported content type") {
		t.Fatalf("error = %v, want unsupported content type", err)
	}
}
