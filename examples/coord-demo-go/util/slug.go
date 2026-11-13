// Package util has small helpers.
package util

import (
	"regexp"
	"strings"
)

var nonAlnum = regexp.MustCompile(`[^a-z0-9]+`)

// Slugify lowercases s and replaces runs of non-alphanumerics with "-".
func Slugify(s string) string {
	return nonAlnum.ReplaceAllString(strings.ToLower(s), "-")
}
