package ai

import (
	"fmt"
	"regexp"
	"strings"

	"ishell/backend/storage"
)

var quickShortcutPattern = regexp.MustCompile(`^(?:ctrl|control)\+?([1-9])$`)

type quickCommandGroupView struct {
	name     string
	commands []storage.QuickCommand
}

type quickCommandMatch struct {
	groupName string
	label     string
	shortcut  string
	command   string
}

func resolveQuickCommand(settings *storage.Settings, name, shortcut, group string) (quickCommandMatch, error) {
	name = strings.TrimSpace(name)
	shortcut = strings.TrimSpace(shortcut)
	group = strings.TrimSpace(group)
	if name == "" && shortcut == "" {
		return quickCommandMatch{}, fmt.Errorf("quick command name or shortcut is required")
	}

	shortcutIndex := -1
	if shortcut != "" {
		idx, err := parseQuickCommandShortcut(shortcut)
		if err != nil {
			return quickCommandMatch{}, err
		}
		shortcutIndex = idx
	}

	candidates := quickCommandMatches(settings, group)
	if group != "" && len(candidates) == 0 {
		return quickCommandMatch{}, fmt.Errorf("quick command group %q was not found or has no runnable commands", group)
	}

	matches := filterQuickCommandMatches(candidates, name, shortcutIndex)
	if len(matches) == 0 {
		if name != "" && shortcutIndex >= 0 {
			nameMatches := filterQuickCommandMatches(candidates, name, -1)
			shortcutMatches := filterQuickCommandMatches(candidates, "", shortcutIndex)
			if len(nameMatches) > 0 && len(shortcutMatches) > 0 {
				return quickCommandMatch{}, fmt.Errorf("quick command name %q and shortcut %s refer to different commands", name, quickShortcutLabel(shortcutIndex))
			}
		}
		return quickCommandMatch{}, fmt.Errorf("no quick command matched name %q shortcut %q group %q", name, shortcut, group)
	}
	if len(matches) > 1 {
		return quickCommandMatch{}, fmt.Errorf("quick command is ambiguous: %s; specify group", describeQuickCommandMatches(matches))
	}
	return matches[0], nil
}

func quickCommandMatches(settings *storage.Settings, group string) []quickCommandMatch {
	groups := quickCommandGroups(settings)
	groupKey := normalizeQuickCommandText(group)
	var matches []quickCommandMatch
	for _, g := range groups {
		if groupKey != "" && normalizeQuickCommandText(g.name) != groupKey {
			continue
		}
		shortcutIndex := 0
		for _, cmd := range g.commands {
			if strings.TrimSpace(cmd.Command) == "" {
				continue
			}
			match := quickCommandMatch{
				groupName: g.name,
				label:     cmd.Label,
				command:   cmd.Command,
			}
			if shortcutIndex < 9 {
				match.shortcut = quickShortcutLabel(shortcutIndex)
			}
			matches = append(matches, match)
			shortcutIndex++
		}
	}
	return matches
}

func quickCommandGroups(settings *storage.Settings) []quickCommandGroupView {
	if settings == nil {
		return nil
	}
	if len(settings.QuickCommandGroups) > 0 {
		groups := make([]quickCommandGroupView, 0, len(settings.QuickCommandGroups))
		for _, g := range settings.QuickCommandGroups {
			groups = append(groups, quickCommandGroupView{name: g.Name, commands: g.Commands})
		}
		return groups
	}
	if len(settings.QuickCommands) == 0 {
		return nil
	}
	return []quickCommandGroupView{{name: "Default", commands: settings.QuickCommands}}
}

func filterQuickCommandMatches(candidates []quickCommandMatch, name string, shortcutIndex int) []quickCommandMatch {
	nameKey := normalizeQuickCommandText(name)
	shortcutLabel := ""
	if shortcutIndex >= 0 {
		shortcutLabel = quickShortcutLabel(shortcutIndex)
	}
	matches := make([]quickCommandMatch, 0, len(candidates))
	for _, candidate := range candidates {
		if nameKey != "" && normalizeQuickCommandText(candidate.label) != nameKey {
			continue
		}
		if shortcutLabel != "" && candidate.shortcut != shortcutLabel {
			continue
		}
		matches = append(matches, candidate)
	}
	return matches
}

func parseQuickCommandShortcut(shortcut string) (int, error) {
	normalized := strings.ToLower(strings.TrimSpace(shortcut))
	normalized = strings.ReplaceAll(normalized, " ", "")
	normalized = strings.TrimPrefix(normalized, "^")
	normalized = strings.TrimPrefix(normalized, "⌃")
	if len(normalized) == 1 && normalized[0] >= '1' && normalized[0] <= '9' {
		return int(normalized[0] - '1'), nil
	}
	m := quickShortcutPattern.FindStringSubmatch(normalized)
	if m == nil {
		return -1, fmt.Errorf("unsupported quick command shortcut %q; use Ctrl+1 through Ctrl+9", shortcut)
	}
	return int(m[1][0] - '1'), nil
}

func quickShortcutLabel(idx int) string {
	return fmt.Sprintf("Ctrl+%d", idx+1)
}

func normalizeQuickCommandText(text string) string {
	return strings.ToLower(strings.TrimSpace(text))
}

func describeQuickCommandMatches(matches []quickCommandMatch) string {
	parts := make([]string, 0, len(matches))
	for _, match := range matches {
		label := match.label
		if strings.TrimSpace(label) == "" {
			label = match.command
		}
		if match.shortcut != "" {
			parts = append(parts, fmt.Sprintf("%q in group %q (%s)", label, match.groupName, match.shortcut))
		} else {
			parts = append(parts, fmt.Sprintf("%q in group %q", label, match.groupName))
		}
	}
	return strings.Join(parts, "; ")
}
