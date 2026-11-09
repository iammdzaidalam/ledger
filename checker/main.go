package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
)

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	writer := bufio.NewWriter(os.Stdout)
	defer writer.Flush()

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var req CheckRequest
		var resp CheckResponse
		if err := json.Unmarshal(line, &req); err != nil {
			resp = CheckResponse{Claims: []ClaimResult{}, Error: err.Error()}
		} else {
			resp = Evaluate(req)
		}
		encoded, err := json.Marshal(resp)
		if err != nil {
			encoded, _ = json.Marshal(CheckResponse{RequestID: req.RequestID, Claims: []ClaimResult{}, Error: err.Error()})
		}
		fmt.Fprintln(writer, string(encoded))
		writer.Flush()
	}
}
