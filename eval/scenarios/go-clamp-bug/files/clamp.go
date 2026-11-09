package clamp

func Clamp(v, lo, hi int) int {
	if v < lo {
		return hi
	}
	if v > hi {
		return hi
	}
	return v
}
