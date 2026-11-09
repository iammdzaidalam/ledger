package main

import "testing"

func TestRuleFileCreated(t *testing.T) {
	t.Run("write succeeded for the claimed path", func(t *testing.T) {
		ev := []Evidence{write(1, "src/config.json", "@@\n+{}\n")}
		check(t, "I created `src/config.json`.", ev, nil, want{KindFileCreated, Verified})
	})
	t.Run("write failed", func(t *testing.T) {
		ev := []Evidence{failedWrite(1, "/etc/app.conf", "EACCES: permission denied")}
		check(t, "I created /etc/app.conf.", ev, nil, want{KindFileCreated, Contradicted})
	})
	t.Run("claimed path was never written", func(t *testing.T) {
		ev := []Evidence{write(1, "src/a.ts", "@@\n+x\n")}
		check(t, "I created src/b.ts as well.", ev, nil, want{KindFileCreated, Unsupported})
	})
	t.Run("no writes at all", func(t *testing.T) {
		check(t, "I wrote the file as requested.", nil, nil, want{KindFileCreated, Unsupported})
	})
	t.Run("relative and nested paths match", func(t *testing.T) {
		ev := []Evidence{write(1, "./docs/notes.md", "@@\n+hi\n")}
		check(t, "Saved notes.md in docs.", ev, nil, want{KindFileCreated, Verified})
	})
	t.Run("created through bash", func(t *testing.T) {
		ev := []Evidence{bash(1, "touch build/.keep", intPtr(0), "")}
		check(t, "I created build/.keep.", ev, nil, want{KindFileCreated, Verified})
	})
	t.Run("bash creation failed", func(t *testing.T) {
		ev := []Evidence{bash(1, "echo hi > out/log.txt", intPtr(1), "")}
		check(t, "I created out/log.txt.", ev, nil, want{KindFileCreated, Contradicted})
	})
}
