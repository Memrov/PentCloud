// The wire boundary is JSON so this package uses the same decoded values as the
// original HTTP/launcher path. All rendering and launch policy stay in Go.
package main

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/Memrov/pentagi-artifacts/internal/contracts"
	"github.com/Memrov/pentagi-artifacts/internal/launchprompt"
	"github.com/Memrov/pentagi-artifacts/internal/prompts"
)

type request struct {
	Operation string             `json:"operation"`
	Source    string             `json:"source"`
	Data      prompts.RenderData `json:"data"`
	Role      string             `json:"role"`
	Args      json.RawMessage    `json:"args"`
	Context   struct {
		Now          time.Time `json:"now"`
		Cwd          string    `json:"cwd"`
		DockerImage  string    `json:"dockerImage"`
		Lang         string    `json:"lang"`
		UserFiles    string    `json:"userFiles"`
		EnabledTools []string  `json:"enabledTools"`
	} `json:"context"`
}

type response struct {
	Prompt       string `json:"prompt,omitempty"`
	PromptDigest string `json:"promptDigest,omitempty"`
	Error        string `json:"error,omitempty"`
}

func render(input []byte) (response, error) {
	var req request
	if err := json.Unmarshal(input, &req); err != nil {
		return response{}, fmt.Errorf("decode renderer request: %w", err)
	}
	switch req.Operation {
	case "template":
		// A role selects only the template diagnostic name. RenderSource invokes
		// the exact imported text/template implementation with no extra funcs.
		body, _, err := prompts.RenderSource(contracts.RoleCoder, []byte(req.Source), req.Data)
		return response{Prompt: string(body)}, err
	case "launch":
		tool := req.Role
		switch tool {
		case "adviser":
			tool = "advice"
		case "searcher":
			tool = "search"
		}
		launch, err := launchprompt.BuildWithTemplate(tool, req.Args, launchprompt.Context{
			Now: req.Context.Now, Cwd: req.Context.Cwd, DockerImage: req.Context.DockerImage,
			Lang: req.Context.Lang, UserFiles: req.Context.UserFiles, EnabledTools: req.Context.EnabledTools,
		}, []byte(req.Source))
		return response{Prompt: launch.Prompt, PromptDigest: launch.PromptDigest}, err
	default:
		return response{}, fmt.Errorf("unknown renderer operation %q", req.Operation)
	}
}

func renderJSON(input string) string {
	result, err := render([]byte(input))
	if err != nil {
		result = response{Error: err.Error()}
	}
	encoded, _ := json.Marshal(result)
	return string(encoded)
}
