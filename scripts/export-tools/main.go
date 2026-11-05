//go:build pentagi_import

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"

	"pentagi/pkg/tools"
)

type snapshot struct {
	Tools []tool `json:"tools"`
}

type tool struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Category    string `json:"category"`
	InputSchema any    `json:"input_schema"`
}

func main() {
	definitions := tools.GetRegistryDefinitions()
	types := tools.GetToolTypeMapping()
	names := make([]string, 0, len(definitions))
	for name := range definitions {
		names = append(names, name)
	}
	sort.Strings(names)

	out := snapshot{Tools: make([]tool, 0, len(names))}
	for _, name := range names {
		definition := definitions[name]
		out.Tools = append(out.Tools, tool{
			Name:        definition.Name,
			Description: definition.Description,
			Category:    types[name].String(),
			InputSchema: definition.Parameters,
		})
	}

	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(out); err != nil {
		fmt.Fprintf(os.Stderr, "encode tool snapshot: %v\n", err)
		os.Exit(1)
	}
}
