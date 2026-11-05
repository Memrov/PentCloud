package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestTemplateGoldenBytes(t *testing.T) {
	encoded, err := os.ReadFile("../../internal/prompts/testdata/render-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases map[string]map[string]any
	if err := json.Unmarshal(encoded, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ role, file string }{{"primary", "primary_agent"}, {"pentester", "pentester"}} {
		t.Run(tc.role, func(t *testing.T) {
			source, err := os.ReadFile("../../internal/prompts/assets/" + tc.file + ".tmpl")
			if err != nil {
				t.Fatal(err)
			}
			want, err := os.ReadFile("../../internal/prompts/testdata/" + tc.file + ".golden")
			if err != nil {
				t.Fatal(err)
			}
			input, _ := json.Marshal(map[string]any{"operation": "template", "source": string(source), "data": cases[tc.role]})
			got, err := render(input)
			if err != nil {
				t.Fatal(err)
			}
			if got.Prompt != string(want) {
				t.Fatal("rendered bytes differ from pinned upstream golden")
			}
		})
	}
}

func TestValidation(t *testing.T) {
	for _, tc := range []struct{ input, message string }{
		{`{"operation":"template","source":"{{if .Lang}}missing end"}`, "parse prompt"},
		{`{"operation":"template","source":"{{unknown .Lang}}"}`, "not defined"},
		{`{"operation":"template","source":"{{index .List 9}}","data":{"List":[1]}}`, "index out of range"},
		{`{"operation":"launch","role":"coder","source":""}`, "override is empty"},
		{`{"operation":"launch","role":"unknown","source":"x","args":{}}`, "not a specialist"},
		{`{"operation":"launch","role":"coder","source":"x","args":null}`, "must be an object"},
	} {
		_, err := render([]byte(tc.input))
		if err == nil || !strings.Contains(err.Error(), tc.message) {
			t.Errorf("render(%s): got %v; want %s", tc.input, err, tc.message)
		}
	}
}
