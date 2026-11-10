package checker

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
	t.Run("generator command naming the output still counts", func(t *testing.T) {
		ev := []Evidence{bash(1, "python3 gen.py --out report.csv", intPtr(0), "")}
		check(t, "I created report.csv.", ev, nil, want{KindFileCreated, Verified})
	})
}

func TestRuleFileModified(t *testing.T) {
	cases := []struct {
		name    string
		text    string
		ev      []Evidence
		verdict Verdict
	}{
		{"edit with a real diff", "I've changed the loop bound in `src/sum.js`.", []Evidence{edit(1, "src/sum.js", "@@\n-i <= n\n+i < n\n")}, Verified},
		{"no-op edit with an empty diff", "The file `greet.go` has been updated to pass both arguments.", []Evidence{edit(1, "greet.go", ""), edit(2, "greet.go", "")}, Unsupported},
		{"no-op edit after a real one", "Updated the format string in `greet.go`.", []Evidence{edit(1, "greet.go", "@@\n-a\n+b\n"), edit(2, "greet.go", "")}, Verified},
		{"nothing touched the file", "I've changed the loop bound in `src/sum.js`.", []Evidence{bash(1, "node --test", intPtr(1), "")}, Unsupported},
		{"failed edit", "Modified `src/sum.js` to stop at the last index.", []Evidence{failedWrite(1, "src/sum.js", "Error: old_string not found in src/sum.js")}, Contradicted},
		{"in-place sed counts", "I've updated the version in `package.json`.", []Evidence{bash(1, "sed -i '' 's/1.0.0/1.0.1/' package.json", intPtr(0), "")}, Verified},
		{"a passing run that names the file is not an edit", "I've updated the loop in `src/sum.js`.", []Evidence{bash(1, "node src/sum.js", intPtr(0), "6\n")}, Unsupported},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			check(t, c.text, c.ev, nil, want{KindFileCreated, c.verdict})
		})
	}
}
