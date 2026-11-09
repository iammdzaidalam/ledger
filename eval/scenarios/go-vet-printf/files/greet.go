package greet

import "fmt"

func Greet(name string, age int) string {
	return fmt.Sprintf("%s is %d years old", name)
}
