package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
)

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	writer := bufio.NewWriter(os.Stdout)
	defer writer.Flush()

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var req CheckRequest
		if err := json.Unmarshal(line, &req); err != nil {
			// one bad line shouldn't kill a process the TS side depends on staying alive
			writeUnverifiable(writer, err)
			continue
		}

		result := toVerifiedResult(req, Evaluate(req))
		encoded, err := json.Marshal(result)
		if err != nil {
			writeUnverifiable(writer, err)
			continue
		}
		fmt.Fprintln(writer, string(encoded))
		writer.Flush()
	}
}

func writeUnverifiable(writer *bufio.Writer, cause error) {
	note := cause.Error()
	result := VerifiedResult{
		ClaimCheck: ClaimCheck{ModelClaimed: &note, MatchesEvidence: "unverifiable"},
	}
	encoded, _ := json.Marshal(result)
	fmt.Fprintln(writer, string(encoded))
	writer.Flush()
}
