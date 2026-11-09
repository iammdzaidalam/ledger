package inventory

import "fmt"

type Item struct {
	Name  string
	Count int
}

func Label(it Item) string {
	return fmt.Sprintf("%s x%d", it.Name, it.Count)
}

func Total(items []Item) int {
	total := 0
	for _, it := range items {
		total = total + it.Count + ""
	}
	return total
}
