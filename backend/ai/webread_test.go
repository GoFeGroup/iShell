package ai

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
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
	out, err := webReadResponseOutput(testWebReadResponse("text/html; charset=utf-8", http.StatusOK, `<!doctype html>
			<html>
				<head>
					<title>Example Page</title>
					<style>.hidden{display:none}</style>
					<script>window.secret = "nope"</script>
				</head>
				<body><h1>Hello</h1><p>Visible text.</p><noscript>noscript text</noscript></body>
			</html>`))
	if err != nil {
		t.Fatalf("webReadResponseOutput: %v", err)
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
	out, err := webReadResponseOutput(testWebReadResponse("text/plain", http.StatusOK, strings.Repeat("x", maxWebReadContentLen*2)))
	if err != nil {
		t.Fatalf("webReadResponseOutput: %v", err)
	}
	if !strings.Contains(out, webReadTruncation) || !strings.Contains(out, "Note: response content was truncated.") {
		t.Fatalf("output should be truncated:\n%s", out)
	}
}

func TestOpenURLReturnsHTTPStatusErrors(t *testing.T) {
	_, err := webReadResponseOutput(testWebReadResponse("text/plain", http.StatusNotFound, "missing page\n"))
	if err == nil {
		t.Fatal("webReadResponseOutput returned nil error for non-2xx response")
	}
	if !strings.Contains(fmt.Sprint(err), "404") || !strings.Contains(fmt.Sprint(err), "missing page") {
		t.Fatalf("error = %v, want status and body", err)
	}
}

func TestOpenURLRejectsBinaryContent(t *testing.T) {
	resp := testWebReadResponse("application/octet-stream", http.StatusOK, string([]byte{0, 1, 2, 3}))
	_, err := webReadResponseOutput(resp)
	if err == nil {
		t.Fatal("webReadResponseOutput returned nil error for binary content")
	}
	if !strings.Contains(fmt.Sprint(err), "unsupported content type") {
		t.Fatalf("error = %v, want unsupported content type", err)
	}
}

func TestOpenURLRejectsNonPublicAddresses(t *testing.T) {
	for _, raw := range []string{
		"http://127.0.0.1:8080",
		"http://localhost:8080",
		"http://169.254.169.254/latest/meta-data",
		"http://10.0.0.5",
		"http://192.168.1.10",
		"http://[::1]/",
	} {
		u, err := normalizeOpenURL(raw)
		if err != nil {
			t.Fatalf("normalizeOpenURL(%q): %v", raw, err)
		}
		if err := validateOpenURLTarget(context.Background(), u); err == nil {
			t.Fatalf("validateOpenURLTarget(%q) returned nil error", raw)
		}
	}
}

func TestDialPublicContextRevalidatesDNSAtDialTime(t *testing.T) {
	originalLookup := lookupNetIP
	t.Cleanup(func() { lookupNetIP = originalLookup })

	lookupNetIP = func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
	}
	u, err := normalizeOpenURL("http://rebind.example")
	if err != nil {
		t.Fatal(err)
	}
	if err := validateOpenURLTarget(context.Background(), u); err != nil {
		t.Fatalf("initial public validation failed: %v", err)
	}

	lookupNetIP = func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
	}
	if _, err := dialPublicContext(context.Background(), "tcp", "rebind.example:80"); err == nil {
		t.Fatal("dialPublicContext accepted a DNS-rebound loopback address")
	}
}

func testWebReadResponse(contentType string, status int, body string) *http.Response {
	statusText := fmt.Sprintf("%d %s", status, http.StatusText(status))
	if statusText == fmt.Sprintf("%d ", status) {
		statusText = fmt.Sprint(status)
	}
	u, _ := url.Parse("https://example.com/page")
	return &http.Response{
		StatusCode: status,
		Status:     statusText,
		Header: http.Header{
			"Content-Type": []string{contentType},
		},
		Body:    io.NopCloser(strings.NewReader(body)),
		Request: &http.Request{URL: u},
	}
}
