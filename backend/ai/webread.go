package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/html"
)

const (
	maxWebReadBodyBytes     = 512 * 1024
	maxWebReadContentLen    = 32 * 1024
	webReadTruncation       = "\n... [truncated]"
	webReadRequestUserAgent = "iShell AI open_url"
	maxWebReadRedirects     = 5
)

var webReadClient = &http.Client{
	Timeout: 12 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= maxWebReadRedirects {
			return fmt.Errorf("stopped after %d redirects", maxWebReadRedirects)
		}
		return validateOpenURLTargetFunc(req.Context(), req.URL)
	},
}

var validateOpenURLTargetFunc = validateOpenURLTarget

type webReadResult struct {
	URL         string
	Status      string
	ContentType string
	Title       string
	Text        string
	Truncated   bool
}

func (ag *Agent) handleOpenURL(ctx context.Context, opts RunOptions, call ToolCall) string {
	var args struct {
		URL string `json:"url"`
	}
	_ = json.Unmarshal([]byte(call.Function.Arguments), &args)
	target := strings.TrimSpace(args.URL)
	if target == "" {
		return `error: open_url requires a non-empty "url"`
	}

	output, err := openURL(ctx, target)
	if err != nil {
		output = fmt.Sprintf("error: %v", err)
	}
	ag.emit("ai:tool_result:"+opts.ChatID, map[string]any{
		"tool_call_id": call.ID,
		"tool":         call.Function.Name,
		"command":      target,
		"output":       output,
		"auto":         true,
	})
	return output
}

func openURL(ctx context.Context, raw string) (string, error) {
	u, err := normalizeOpenURL(raw)
	if err != nil {
		return "", err
	}
	if err := validateOpenURLTargetFunc(ctx, u); err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", fmt.Errorf("build open_url request: %w", err)
	}
	req.Header.Set("Accept", "text/html, text/plain, application/json, application/xml, */*;q=0.8")
	req.Header.Set("User-Agent", webReadRequestUserAgent)

	resp, err := webReadClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("open_url request failed: %w", err)
	}
	defer resp.Body.Close()

	return webReadResponseOutput(resp)
}

func webReadResponseOutput(resp *http.Response) (string, error) {
	body, truncated, err := readLimited(resp.Body, maxWebReadBodyBytes)
	if err != nil {
		return "", fmt.Errorf("read open_url response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("open_url error %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}

	result, err := readableWebResponse(resp, body)
	if err != nil {
		return "", err
	}
	result.Truncated = result.Truncated || truncated
	return formatWebReadResult(result), nil
}

func normalizeOpenURL(raw string) (*url.URL, error) {
	target := strings.TrimSpace(raw)
	if target == "" {
		return nil, fmt.Errorf("empty URL")
	}
	if !strings.Contains(target, "://") {
		target = "https://" + target
	}
	u, err := url.Parse(target)
	if err != nil {
		return nil, fmt.Errorf("parse URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("unsupported URL scheme %q; only http and https are supported", u.Scheme)
	}
	if u.Host == "" {
		return nil, fmt.Errorf("URL is missing a host")
	}
	return u, nil
}

func validateOpenURLTarget(ctx context.Context, u *url.URL) error {
	if u == nil {
		return fmt.Errorf("URL is missing")
	}
	hostname := strings.TrimSuffix(u.Hostname(), ".")
	if hostname == "" {
		return fmt.Errorf("URL is missing a host")
	}
	if addr, err := netip.ParseAddr(hostname); err == nil {
		return validatePublicAddr(addr, hostname)
	}
	addrs, err := net.DefaultResolver.LookupNetIP(ctx, "ip", hostname)
	if err != nil {
		return fmt.Errorf("resolve %s: %w", hostname, err)
	}
	if len(addrs) == 0 {
		return fmt.Errorf("resolve %s: no addresses", hostname)
	}
	for _, addr := range addrs {
		if err := validatePublicAddr(addr, hostname); err != nil {
			return err
		}
	}
	return nil
}

func validatePublicAddr(addr netip.Addr, hostname string) error {
	if addr.IsLoopback() ||
		addr.IsPrivate() ||
		addr.IsLinkLocalUnicast() ||
		addr.IsLinkLocalMulticast() ||
		addr.IsInterfaceLocalMulticast() ||
		addr.IsMulticast() ||
		addr.IsUnspecified() {
		return fmt.Errorf("refusing to open URL host %q resolved to non-public address %s", hostname, addr)
	}
	return nil
}

func readLimited(r io.Reader, limit int64) ([]byte, bool, error) {
	body, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(body)) <= limit {
		return body, false, nil
	}
	return body[:limit], true, nil
}

func readableWebResponse(resp *http.Response, body []byte) (webReadResult, error) {
	contentType := resp.Header.Get("Content-Type")
	mediaType := normalizedMediaType(contentType)
	if mediaType == "" && len(body) > 0 {
		mediaType = normalizedMediaType(http.DetectContentType(body))
	}

	result := webReadResult{
		URL:         resp.Request.URL.String(),
		Status:      resp.Status,
		ContentType: firstNonEmpty(contentType, mediaType),
	}

	switch {
	case mediaType == "text/html" || mediaType == "application/xhtml+xml":
		title, text, err := extractHTMLText(body)
		if err != nil {
			return webReadResult{}, fmt.Errorf("parse HTML response: %w", err)
		}
		result.Title = title
		result.Text, result.Truncated = truncateWebReadText(text, maxWebReadContentLen)
		return result, nil
	case strings.HasPrefix(mediaType, "text/") || strings.Contains(mediaType, "json") || strings.Contains(mediaType, "xml"):
		text := strings.TrimSpace(string(body))
		result.Text, result.Truncated = truncateWebReadText(text, maxWebReadContentLen)
		return result, nil
	default:
		return webReadResult{}, fmt.Errorf("unsupported content type %q", result.ContentType)
	}
}

func normalizedMediaType(contentType string) string {
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		mediaType = strings.TrimSpace(strings.Split(contentType, ";")[0])
	}
	return strings.ToLower(mediaType)
}

func extractHTMLText(body []byte) (string, string, error) {
	doc, err := html.Parse(strings.NewReader(string(body)))
	if err != nil {
		return "", "", err
	}

	var title string
	var parts []string
	var walk func(*html.Node, bool)
	walk = func(n *html.Node, skip bool) {
		nextSkip := skip
		if n.Type == html.ElementNode {
			switch strings.ToLower(n.Data) {
			case "script", "style", "noscript", "svg", "head", "title":
				nextSkip = true
			}
			if strings.EqualFold(n.Data, "title") && title == "" {
				title = strings.TrimSpace(nodeText(n))
			}
		}
		if n.Type == html.TextNode && !nextSkip {
			if text := strings.TrimSpace(n.Data); text != "" {
				parts = append(parts, text)
			}
		}
		for child := n.FirstChild; child != nil; child = child.NextSibling {
			walk(child, nextSkip)
		}
	}
	walk(doc, false)
	return normalizeToolOutput(title), normalizeToolOutput(strings.Join(parts, " ")), nil
}

func nodeText(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(cur *html.Node) {
		if cur.Type == html.TextNode {
			b.WriteString(cur.Data)
			b.WriteByte(' ')
		}
		for child := cur.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(n)
	return b.String()
}

func truncateWebReadText(value string, limit int) (string, bool) {
	if limit <= 0 || len(value) <= limit {
		return value, false
	}
	if limit <= len(webReadTruncation) {
		return webReadTruncation[:limit], true
	}
	maxPrefix := limit - len(webReadTruncation)
	cutoff := 0
	for i := range value {
		if i > maxPrefix {
			break
		}
		cutoff = i
	}
	return value[:cutoff] + webReadTruncation, true
}

func formatWebReadResult(result webReadResult) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Opened URL: %s\n", result.URL)
	if result.Status != "" {
		fmt.Fprintf(&b, "Status: %s\n", result.Status)
	}
	if result.ContentType != "" {
		fmt.Fprintf(&b, "Content-Type: %s\n", result.ContentType)
	}
	if result.Title != "" {
		fmt.Fprintf(&b, "Title: %s\n", result.Title)
	}
	if result.Text != "" {
		fmt.Fprintf(&b, "Content:\n%s\n", result.Text)
	}
	if result.Truncated {
		fmt.Fprintln(&b, "Note: response content was truncated.")
	}
	return strings.TrimSpace(b.String())
}
