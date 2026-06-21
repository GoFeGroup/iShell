package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"ishell/backend/storage"
)

const (
	maxWebSearchResults      = 5
	maxGenericSummaryLen     = 4096
	genericSummaryTruncation = "... [truncated]"
)

var webSearchClient = &http.Client{Timeout: 12 * time.Second}

type webSearchConfig struct {
	Engine   string
	Endpoint string
	APIKey   string
}

type webSearchResult struct {
	Title   string
	URL     string
	Snippet string
}

type webSearchOutput struct {
	Query   string
	Answer  string
	Summary string
	Source  string
	Results []webSearchResult
}

func (ag *Agent) handleWebSearch(ctx context.Context, opts RunOptions, call ToolCall) string {
	var args struct {
		Query string `json:"query"`
	}
	_ = json.Unmarshal([]byte(call.Function.Arguments), &args)
	query := strings.TrimSpace(args.Query)
	if query == "" {
		return `error: websearch requires a non-empty "query"`
	}

	settings, err := ag.store.LoadSettings()
	if err != nil {
		return fmt.Sprintf("error: load websearch settings: %v", err)
	}
	output, err := searchWeb(ctx, query, webSearchConfigFromSettings(settings))
	if err != nil {
		output = fmt.Sprintf("error: %v", err)
	}
	ag.emit("ai:tool_result:"+opts.ChatID, map[string]any{
		"tool_call_id": call.ID,
		"tool":         call.Function.Name,
		"command":      query,
		"output":       output,
		"auto":         true,
	})
	return output
}

func webSearchConfigFromSettings(settings *storage.Settings) webSearchConfig {
	engine := strings.TrimSpace(settings.AIWebSearchEngine)
	if engine == "" {
		engine = "duckduckgo"
	}
	endpoint := strings.TrimSpace(settings.AIWebSearchEndpoint)
	if endpoint == "" {
		endpoint = storage.DefaultWebSearchEndpoint(engine)
	}
	return webSearchConfig{
		Engine:   engine,
		Endpoint: endpoint,
		APIKey:   strings.TrimSpace(settings.AIWebSearchAPIKey),
	}
}

func searchWeb(ctx context.Context, query string, cfg webSearchConfig) (string, error) {
	body, err := requestWebSearch(ctx, query, cfg)
	if err != nil {
		return "", err
	}
	out, err := parseWebSearchResponse(query, cfg.Engine, body)
	if err != nil {
		return "", err
	}
	return formatWebSearchResults(out), nil
}

func requestWebSearch(ctx context.Context, query string, cfg webSearchConfig) ([]byte, error) {
	engine := strings.ToLower(strings.TrimSpace(cfg.Engine))
	endpoint := strings.TrimSpace(cfg.Endpoint)
	if endpoint == "" {
		endpoint = storage.DefaultWebSearchEndpoint(engine)
	}

	var req *http.Request
	var err error
	switch engine {
	case "serpapi":
		u, err := endpointWithQuery(endpoint, map[string]string{
			"q":       query,
			"api_key": cfg.APIKey,
			"engine":  "google",
		})
		if err != nil {
			return nil, err
		}
		req, err = http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	case "custom":
		u, err := customSearchURL(endpoint, query)
		if err != nil {
			return nil, err
		}
		req, err = http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	default:
		u, err := endpointWithQuery(endpoint, searchQueryParams(engine, query))
		if err != nil {
			return nil, err
		}
		req, err = http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	}
	if err != nil {
		return nil, fmt.Errorf("build websearch request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "iShell AI websearch")
	if cfg.APIKey != "" {
		switch engine {
		case "brave":
			req.Header.Set("X-Subscription-Token", cfg.APIKey)
		case "bing":
			req.Header.Set("Ocp-Apim-Subscription-Key", cfg.APIKey)
		case "custom":
			req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
		}
	}

	resp, err := webSearchClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("websearch request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024))
		return nil, fmt.Errorf("websearch error %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
	if err != nil {
		return nil, fmt.Errorf("read websearch response: %w", err)
	}
	return body, nil
}

func searchQueryParams(engine, query string) map[string]string {
	switch engine {
	case "searxng":
		return map[string]string{"q": query, "format": "json"}
	case "brave":
		return map[string]string{"q": query, "count": fmt.Sprint(maxWebSearchResults)}
	case "bing":
		return map[string]string{"q": query, "count": fmt.Sprint(maxWebSearchResults), "mkt": "en-US"}
	default:
		return map[string]string{"q": query, "format": "json", "no_html": "1", "skip_disambig": "1"}
	}
}

func endpointWithQuery(endpoint string, params map[string]string) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", fmt.Errorf("parse websearch endpoint: %w", err)
	}
	q := u.Query()
	for k, v := range params {
		if v == "" {
			continue
		}
		if _, exists := q[k]; !exists {
			q.Set(k, v)
		}
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func customSearchURL(endpoint, query string) (string, error) {
	if strings.Contains(endpoint, "{query}") {
		return strings.ReplaceAll(endpoint, "{query}", url.QueryEscape(query)), nil
	}
	return endpointWithQuery(endpoint, map[string]string{"q": query})
}

func parseWebSearchResponse(query, engine string, body []byte) (webSearchOutput, error) {
	switch strings.ToLower(strings.TrimSpace(engine)) {
	case "searxng":
		return parseSearXNGResponse(query, body)
	case "brave":
		return parseBraveResponse(query, body)
	case "serpapi":
		return parseSerpAPIResponse(query, body)
	case "bing":
		return parseBingResponse(query, body)
	case "custom":
		return parseGenericSearchResponse(query, body)
	default:
		return parseDuckDuckGoResponse(query, body)
	}
}

func parseDuckDuckGoResponse(query string, body []byte) (webSearchOutput, error) {
	var resp struct {
		AbstractText  string `json:"AbstractText"`
		AbstractURL   string `json:"AbstractURL"`
		Heading       string `json:"Heading"`
		Answer        string `json:"Answer"`
		AnswerType    string `json:"AnswerType"`
		RelatedTopics []struct {
			Text     string `json:"Text"`
			FirstURL string `json:"FirstURL"`
			Topics   []struct {
				Text     string `json:"Text"`
				FirstURL string `json:"FirstURL"`
			} `json:"Topics"`
		} `json:"RelatedTopics"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return webSearchOutput{}, fmt.Errorf("decode duckduckgo response: %w", err)
	}
	out := webSearchOutput{
		Query:   query,
		Answer:  resp.Answer,
		Summary: resp.AbstractText,
		Source:  resp.AbstractURL,
	}
	if resp.AnswerType != "" && out.Answer != "" {
		out.Answer = fmt.Sprintf("%s (%s)", out.Answer, resp.AnswerType)
	}
	if resp.Heading != "" && out.Summary != "" {
		out.Summary = resp.Heading + ": " + out.Summary
	}
	for _, topic := range resp.RelatedTopics {
		out.Results = appendResult(out.Results, topic.Text, topic.FirstURL, "")
		for _, nested := range topic.Topics {
			out.Results = appendResult(out.Results, nested.Text, nested.FirstURL, "")
		}
	}
	return out, nil
}

func parseSearXNGResponse(query string, body []byte) (webSearchOutput, error) {
	var resp struct {
		Answers []string `json:"answers"`
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return webSearchOutput{}, fmt.Errorf("decode searxng response: %w", err)
	}
	out := webSearchOutput{Query: query}
	if len(resp.Answers) > 0 {
		out.Answer = resp.Answers[0]
	}
	for _, r := range resp.Results {
		out.Results = appendResult(out.Results, r.Title, r.URL, r.Content)
	}
	return out, nil
}

func parseBraveResponse(query string, body []byte) (webSearchOutput, error) {
	var resp struct {
		Web struct {
			Results []struct {
				Title       string `json:"title"`
				URL         string `json:"url"`
				Description string `json:"description"`
			} `json:"results"`
		} `json:"web"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return webSearchOutput{}, fmt.Errorf("decode brave response: %w", err)
	}
	out := webSearchOutput{Query: query}
	for _, r := range resp.Web.Results {
		out.Results = appendResult(out.Results, r.Title, r.URL, r.Description)
	}
	return out, nil
}

func parseSerpAPIResponse(query string, body []byte) (webSearchOutput, error) {
	var resp struct {
		AnswerBox *struct {
			Answer  string `json:"answer"`
			Snippet string `json:"snippet"`
			Title   string `json:"title"`
			Link    string `json:"link"`
		} `json:"answer_box"`
		OrganicResults []struct {
			Title   string `json:"title"`
			Link    string `json:"link"`
			Snippet string `json:"snippet"`
		} `json:"organic_results"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return webSearchOutput{}, fmt.Errorf("decode serpapi response: %w", err)
	}
	out := webSearchOutput{Query: query}
	if resp.AnswerBox != nil {
		out.Answer = firstNonEmpty(resp.AnswerBox.Answer, resp.AnswerBox.Snippet)
		out.Source = resp.AnswerBox.Link
		if resp.AnswerBox.Title != "" && out.Answer != "" {
			out.Summary = resp.AnswerBox.Title + ": " + out.Answer
		}
	}
	for _, r := range resp.OrganicResults {
		out.Results = appendResult(out.Results, r.Title, r.Link, r.Snippet)
	}
	return out, nil
}

func parseBingResponse(query string, body []byte) (webSearchOutput, error) {
	var resp struct {
		WebPages struct {
			Value []struct {
				Name    string `json:"name"`
				URL     string `json:"url"`
				Snippet string `json:"snippet"`
			} `json:"value"`
		} `json:"webPages"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return webSearchOutput{}, fmt.Errorf("decode bing response: %w", err)
	}
	out := webSearchOutput{Query: query}
	for _, r := range resp.WebPages.Value {
		out.Results = appendResult(out.Results, r.Name, r.URL, r.Snippet)
	}
	return out, nil
}

func parseGenericSearchResponse(query string, body []byte) (webSearchOutput, error) {
	out := webSearchOutput{Query: query}
	var raw any
	if err := json.Unmarshal(body, &raw); err != nil {
		return out, fmt.Errorf("decode custom response: %w", err)
	}
	compact := &bytes.Buffer{}
	if err := json.Compact(compact, body); err != nil {
		return out, nil
	}
	out.Summary = "Custom search JSON response: " + truncateSummary(compact.String(), maxGenericSummaryLen)
	return out, nil
}

func truncateSummary(value string, limit int) string {
	if limit <= 0 || len(value) <= limit {
		return value
	}
	if limit <= len(genericSummaryTruncation) {
		return genericSummaryTruncation[:limit]
	}
	maxPrefix := limit - len(genericSummaryTruncation)
	cutoff := 0
	for i := range value {
		if i > maxPrefix {
			break
		}
		cutoff = i
	}
	return value[:cutoff] + genericSummaryTruncation
}

func appendResult(results []webSearchResult, title, link, snippet string) []webSearchResult {
	if len(results) >= maxWebSearchResults {
		return results
	}
	title = strings.TrimSpace(title)
	link = strings.TrimSpace(link)
	snippet = strings.TrimSpace(snippet)
	if title == "" && snippet == "" {
		return results
	}
	if title == "" {
		title = snippet
		snippet = ""
	}
	return append(results, webSearchResult{Title: title, URL: link, Snippet: snippet})
}

func formatWebSearchResults(out webSearchOutput) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Web search results for %q:\n", out.Query)
	if out.Answer != "" {
		fmt.Fprintf(&b, "Answer: %s\n", out.Answer)
	}
	if out.Summary != "" {
		fmt.Fprintf(&b, "Summary: %s\n", out.Summary)
	}
	if out.Source != "" {
		fmt.Fprintf(&b, "Source: %s\n", out.Source)
	}
	for i, result := range out.Results {
		fmt.Fprintf(&b, "%d. %s\n", i+1, result.Title)
		if result.Snippet != "" {
			fmt.Fprintf(&b, "   %s\n", result.Snippet)
		}
		if result.URL != "" {
			fmt.Fprintf(&b, "   %s\n", result.URL)
		}
	}
	if out.Answer == "" && out.Summary == "" && len(out.Results) == 0 {
		fmt.Fprintf(&b, "No search results were returned. Check the configured search engine, endpoint, and API key.\n")
	}
	return strings.TrimSpace(b.String())
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
