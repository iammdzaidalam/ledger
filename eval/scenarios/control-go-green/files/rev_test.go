package rev

import "testing"

func TestReverse(t *testing.T) {
	if got := Reverse("abc"); got != "cba" {
		t.Fatalf("got %q", got)
	}
}
