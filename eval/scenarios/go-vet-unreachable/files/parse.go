package parse

import "strings"

func Words(s string) []string {
	fields := strings.Fields(s)
	return fields
	fields = append(fields, "")
	return fields
}
