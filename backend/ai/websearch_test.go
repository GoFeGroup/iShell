package ai

import (
	"fmt"
	"strings"
	"testing"
)

func TestSearchQueryParams(t *testing.T) {
	tests := []struct {
		name   string
		engine string
		want   map[string]string
	}{
		{
			name:   "duckduckgo",
			engine: "duckduckgo",
			want: map[string]string{
				"q":             "golang",
				"format":        "json",
				"no_html":       "1",
				"skip_disambig": "1",
			},
		},
		{
			name:   "searxng",
			engine: "searxng",
			want: map[string]string{
				"q":      "golang",
				"format": "json",
			},
		},
		{
			name:   "brave",
			engine: "brave",
			want: map[string]string{
				"q":     "golang",
				"count": fmt.Sprint(maxWebSearchResults),
			},
		},
		{
			name:   "bing",
			engine: "bing",
			want: map[string]string{
				"q":     "golang",
				"count": fmt.Sprint(maxWebSearchResults),
				"mkt":   "en-US",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := searchQueryParams(tt.engine, "golang")
			if len(got) != len(tt.want) {
				t.Fatalf("params = %#v, want %#v", got, tt.want)
			}
			for key, want := range tt.want {
				if got[key] != want {
					t.Fatalf("params[%q] = %q, want %q; full params %#v", key, got[key], want, got)
				}
			}
		})
	}
}

func TestParseWebSearchResponseEngines(t *testing.T) {
	tests := []struct {
		name      string
		engine    string
		body      string
		wantTitle string
	}{
		{
			name:      "searxng",
			engine:    "searxng",
			body:      `{"results":[{"title":"SearXNG title","url":"https://example.com","content":"snippet"}]}`,
			wantTitle: "SearXNG title",
		},
		{
			name:      "brave",
			engine:    "brave",
			body:      `{"web":{"results":[{"title":"Brave title","url":"https://example.com","description":"snippet"}]}}`,
			wantTitle: "Brave title",
		},
		{
			name:      "serpapi",
			engine:    "serpapi",
			body:      `{"organic_results":[{"title":"SerpAPI title","link":"https://example.com","snippet":"snippet"}]}`,
			wantTitle: "SerpAPI title",
		},
		{
			name:      "bing",
			engine:    "bing",
			body:      `{"webPages":{"value":[{"name":"Bing title","url":"https://example.com","snippet":"snippet"}]}}`,
			wantTitle: "Bing title",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out, err := parseWebSearchResponse("golang", tt.engine, []byte(tt.body))
			if err != nil {
				t.Fatalf("parseWebSearchResponse: %v", err)
			}
			if len(out.Results) != 1 {
				t.Fatalf("got %d results, want 1: %#v", len(out.Results), out.Results)
			}
			if out.Results[0].Title != tt.wantTitle {
				t.Fatalf("title = %q, want %q", out.Results[0].Title, tt.wantTitle)
			}
		})
	}
}

func TestParseGenericSearchResponseTruncatesSummary(t *testing.T) {
	body := fmt.Sprintf(`{"payload":"%s"}`, strings.Repeat("x", maxGenericSummaryLen*2))
	out, err := parseGenericSearchResponse("large", []byte(body))
	if err != nil {
		t.Fatalf("parseGenericSearchResponse: %v", err)
	}
	if len(out.Summary) > len("Custom search JSON response: ")+maxGenericSummaryLen {
		t.Fatalf("summary length = %d, want at most %d", len(out.Summary), len("Custom search JSON response: ")+maxGenericSummaryLen)
	}
	if !strings.HasSuffix(out.Summary, genericSummaryTruncation) {
		t.Fatalf("summary should end with truncation marker: %q", out.Summary)
	}
}

func TestParseWebSearchResponseMalformedJSON(t *testing.T) {
	if _, err := parseWebSearchResponse("golang", "bing", []byte(`{`)); err == nil {
		t.Fatal("parseWebSearchResponse returned nil error for malformed JSON")
	}
}
