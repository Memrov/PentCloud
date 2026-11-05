//go:build pentagi_import

package main

import (
	"encoding/json"
	"fmt"
	"os"

	"pentagi/pkg/templates"
)

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "usage: render-golden <prompt-file> <cases-json> <case-name>")
		os.Exit(2)
	}
	prompt, err := os.ReadFile(os.Args[1])
	if err != nil {
		fatal("read prompt", err)
	}
	casesJSON, err := os.ReadFile(os.Args[2])
	if err != nil {
		fatal("read cases", err)
	}
	var cases map[string]map[string]any
	if err := json.Unmarshal(casesJSON, &cases); err != nil {
		fatal("decode cases", err)
	}
	params, ok := cases[os.Args[3]]
	if !ok {
		fatal("select case", fmt.Errorf("unknown case %q", os.Args[3]))
	}
	rendered, err := templates.RenderPrompt(os.Args[3], string(prompt), params)
	if err != nil {
		fatal("render with pinned upstream", err)
	}
	if _, err := os.Stdout.WriteString(rendered); err != nil {
		fatal("write rendered prompt", err)
	}
}

func fatal(action string, err error) {
	fmt.Fprintf(os.Stderr, "%s: %v\n", action, err)
	os.Exit(1)
}
