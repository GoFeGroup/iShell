package ai

import (
	"encoding/json"
	"html"
	"regexp"
	"strconv"
	"strings"
)

var (
	dsmlStartMarkers = []string{"<｜｜DSML｜｜tool_calls>", "<||DSML||tool_calls>"}
	dsmlEndMarkers   = []string{"</｜｜DSML｜｜tool_calls>", "</||DSML||tool_calls>"}
	dsmlInvokeRe     = regexp.MustCompile(`(?s)<[｜|]{2}DSML[｜|]{2}invoke\s+([^>]*)>(.*?)</[｜|]{2}DSML[｜|]{2}invoke>`)
	dsmlParameterRe  = regexp.MustCompile(`(?s)<[｜|]{2}DSML[｜|]{2}parameter\s+([^>]*)>(.*?)</[｜|]{2}DSML[｜|]{2}parameter>`)
	dsmlAttrRe       = regexp.MustCompile(`([a-zA-Z_][a-zA-Z0-9_:-]*)\s*=\s*"([^"]*)"`)
)

type dsmlContentFilter struct {
	pending string
	calls   []ToolCall
	nextID  int
}

func newDSMLContentFilter() *dsmlContentFilter {
	return &dsmlContentFilter{nextID: 1}
}

func (f *dsmlContentFilter) Push(delta string) string {
	if delta == "" {
		return ""
	}
	f.pending += delta
	return f.drain(false)
}

func (f *dsmlContentFilter) Flush() string {
	return f.drain(true)
}

func (f *dsmlContentFilter) ToolCalls() []ToolCall {
	if len(f.calls) == 0 {
		return nil
	}
	calls := make([]ToolCall, len(f.calls))
	copy(calls, f.calls)
	return calls
}

func (f *dsmlContentFilter) drain(flush bool) string {
	var out strings.Builder
	for {
		start := findFirstMarker(f.pending, dsmlStartMarkers)
		if start < 0 {
			keep := 0
			if !flush {
				keep = longestMarkerPrefixSuffix(f.pending, dsmlStartMarkers)
			}
			emitLen := len(f.pending) - keep
			if emitLen > 0 {
				out.WriteString(f.pending[:emitLen])
				f.pending = f.pending[emitLen:]
			}
			return out.String()
		}

		if start > 0 {
			out.WriteString(f.pending[:start])
			f.pending = f.pending[start:]
		}

		endStart, endLen := findFirstMarkerAndLen(f.pending, dsmlEndMarkers)
		if endStart < 0 {
			if flush {
				out.WriteString(f.pending)
				f.pending = ""
			}
			return out.String()
		}

		blockEnd := endStart + endLen
		block := f.pending[:blockEnd]
		f.pending = f.pending[blockEnd:]
		f.calls = append(f.calls, parseDSMLToolCalls(block, &f.nextID)...)
	}
}

func parseDSMLToolCalls(block string, nextID *int) []ToolCall {
	matches := dsmlInvokeRe.FindAllStringSubmatch(block, -1)
	calls := make([]ToolCall, 0, len(matches))
	for _, match := range matches {
		attrs := parseDSMLAttrs(match[1])
		name := attrs["name"]
		if name == "" {
			continue
		}

		args := map[string]any{}
		for _, param := range dsmlParameterRe.FindAllStringSubmatch(match[2], -1) {
			paramAttrs := parseDSMLAttrs(param[1])
			paramName := paramAttrs["name"]
			if paramName == "" {
				continue
			}
			value := strings.TrimSpace(html.UnescapeString(param[2]))
			if strings.EqualFold(paramAttrs["string"], "true") {
				args[paramName] = value
				continue
			}
			var decoded any
			if err := json.Unmarshal([]byte(value), &decoded); err == nil {
				args[paramName] = decoded
			} else {
				args[paramName] = value
			}
		}

		rawArgs, err := json.Marshal(args)
		if err != nil {
			continue
		}
		id := "dsml_call"
		if nextID != nil {
			id = "dsml_call_" + strconv.Itoa(*nextID)
			*nextID = *nextID + 1
		}
		calls = append(calls, ToolCall{
			ID:   id,
			Type: "function",
			Function: ToolCallFunc{
				Name:      name,
				Arguments: string(rawArgs),
			},
		})
	}
	return calls
}

func parseDSMLAttrs(s string) map[string]string {
	attrs := map[string]string{}
	for _, match := range dsmlAttrRe.FindAllStringSubmatch(s, -1) {
		attrs[match[1]] = html.UnescapeString(match[2])
	}
	return attrs
}

func findFirstMarker(s string, markers []string) int {
	idx, _ := findFirstMarkerAndLen(s, markers)
	return idx
}

func findFirstMarkerAndLen(s string, markers []string) (int, int) {
	best := -1
	bestLen := 0
	for _, marker := range markers {
		idx := strings.Index(s, marker)
		if idx >= 0 && (best < 0 || idx < best) {
			best = idx
			bestLen = len(marker)
		}
	}
	return best, bestLen
}

func longestMarkerPrefixSuffix(s string, markers []string) int {
	limit := len(s)
	best := 0
	for _, marker := range markers {
		max := len(marker) - 1
		if max > limit {
			max = limit
		}
		for n := max; n > best; n-- {
			if strings.HasSuffix(s, marker[:n]) {
				best = n
				break
			}
		}
	}
	return best
}
