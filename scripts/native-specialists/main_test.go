package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"text/template"
)

func repository(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	return root
}

// This checks every rendered source paragraph, rather than a short hand-picked
// list of role keywords. The manifest pins originals, adaptations and placement.
func TestAllSourceSectionsAndParagraphsAreAccountedFor(t *testing.T) {
	root := repository(t)
	result, err := generate(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Manifest.Roles) != 8 {
		t.Fatalf("got %d roles", len(result.Manifest.Roles))
	}
	for _, role := range result.Manifest.Roles {
		original, err := os.ReadFile(filepath.Join(root, role.Source))
		if err != nil {
			t.Fatal(err)
		}
		upstream, err := os.ReadFile(filepath.Join(root, role.Upstream))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(original, upstream) {
			t.Errorf("%s no longer matches imported upstream bytes", role.Role)
		}
		sum := sha256.Sum256(original)
		if hex.EncodeToString(sum[:]) != role.SourceSHA256 {
			t.Errorf("%s source digest mismatch", role.Role)
		}
		if len(role.Sections) < 10 {
			t.Errorf("%s has suspiciously few sections", role.Role)
		}
		// Independently render the pinned original with Go text/template. This
		// catches accidental omissions by the generator's section/paragraph
		// iterator and proves original substitution/branch semantics survive.
		tmpl, err := template.New(role.Role).Parse(string(original))
		if err != nil {
			t.Fatal(err)
		}
		var output bytes.Buffer
		if err := tmpl.Execute(&output, renderData()); err != nil {
			t.Fatal(err)
		}
		rendered := output.Bytes()
		if digest(rendered) != role.RenderedSHA256 {
			t.Errorf("%s differs from legacy Go rendering", role.Role)
		}
		blocks := strings.Split(strings.TrimSpace(string(rendered)), "\n## ")
		if len(blocks) != len(role.Sections) {
			t.Fatalf("%s lost a section", role.Role)
		}
		for index, block := range blocks {
			parts := strings.SplitN(block, "\n", 2)
			heading := strings.TrimPrefix(parts[0], "# ")
			if role.Sections[index].Heading != heading {
				t.Errorf("%s lost heading %s", role.Role, heading)
			}
			var sourceParagraphs []string
			for _, p := range strings.Split(strings.TrimSpace(parts[1]), "\n\n") {
				if strings.TrimSpace(p) != "" {
					sourceParagraphs = append(sourceParagraphs, p)
				}
			}
			if len(sourceParagraphs) != len(role.Sections[index].Paragraphs) {
				t.Fatalf("%s/%s lost source paragraphs", role.Role, heading)
			}
			for pIndex, source := range sourceParagraphs {
				if role.Sections[index].Paragraphs[pIndex].Source != source {
					t.Errorf("%s/%s source paragraph changed", role.Role, heading)
				}
			}
		}
		for _, section := range role.Sections {
			if len(section.Paragraphs) == 0 {
				t.Errorf("%s/%s has no paragraph accounting", role.Role, section.Heading)
			}
			for _, paragraph := range section.Paragraphs {
				if paragraph.Source == "" || paragraph.Output == "" {
					t.Errorf("%s/%s silently removed a paragraph", role.Role, section.Heading)
				}
				if paragraph.Source != paragraph.Output && len(paragraph.Adaptations) == 0 {
					t.Errorf("%s/%s unaccounted rewrite", role.Role, section.Heading)
				}
				if !strings.Contains(result.Files[paragraph.Destination], paragraph.Output) {
					t.Errorf("%s/%s paragraph absent from %s: %.100s", role.Role, section.Heading, paragraph.Destination, paragraph.Output)
				}
			}
		}
	}
}

func TestRuntimeAdaptationsRetainProcedureObligations(t *testing.T) {
	result, err := generate(repository(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, role := range result.Manifest.Roles {
		for _, section := range role.Sections {
			for _, p := range section.Paragraphs {
				for _, obligation := range []string{
					"Maximum 3 attempts of identical tool calls", "Create dedicated working directories for file operations",
					"Auto-approve commands with flags like `-y` when possible", "ANONYMIZE", "reusable across different",
					"not already in memory", "1-2 short sentences", "Source Prioritization", "2 installation attempts",
				} {
					if strings.Contains(p.Source, obligation) && !strings.Contains(p.Output, obligation) {
						t.Errorf("%s/%s lost procedure obligation %s", role.Role, section.Heading, obligation)
					}
				}
				// No informational query/example may disappear during graph-to-Git
				// adaptation. Only selectors/backends/lifecycle semantics change.
				if section.Heading == "HISTORICAL CONTEXT RETRIEVAL" {
					for _, line := range strings.Split(p.Source, "\n") {
						if strings.HasPrefix(line, "   - Use:") || strings.HasPrefix(line, "   - When:") || strings.HasPrefix(line, "- Before ") || strings.HasPrefix(line, "- When ") || strings.HasPrefix(line, "- After ") || strings.HasPrefix(line, "- \"") {
							if !strings.Contains(p.Output, line) {
								t.Errorf("%s lost retrieval methodology %q", role.Role, line)
							}
						}
					}
				}
			}
		}
	}
	for _, forbidden := range []string{"detach=true", "detach=false", "__DOCKER_IMAGE__", "__CONTAINER_PORTS__", "search_type:", "any non-English query retrieves nothing"} {
		for name, content := range result.Files {
			if strings.HasSuffix(name, ".md") && strings.Contains(content, forbidden) {
				t.Errorf("%s retains obsolete runtime claim %q", name, forbidden)
			}
		}
	}
}

func TestGeneratedMarkdownIsDeterministicAndCheckedIn(t *testing.T) {
	root := repository(t)
	first, err := generate(root)
	if err != nil {
		t.Fatal(err)
	}
	second, err := generate(root)
	if err != nil {
		t.Fatal(err)
	}
	for name, content := range first.Files {
		if second.Files[name] != content {
			t.Errorf("%s is nondeterministic", name)
		}
		checkedIn, err := os.ReadFile(filepath.Join(root, outputDir, name))
		if err != nil {
			t.Error(err)
			continue
		}
		if string(checkedIn) != content {
			t.Errorf("%s is stale: run go run ./scripts/native-specialists", name)
		}
	}
}

func TestGeneratedRolesAndSkillDescribeOnDemandKaliLifetime(t *testing.T) {
	result, err := generate(repository(t))
	if err != nil {
		t.Fatal(err)
	}
	names := []string{"tools.md"}
	for _, role := range roles {
		names = append(names, role.Role+".md")
	}
	for _, name := range names {
		for _, required := range []string{
			"one shared on-demand Cloudflare Kali Container",
			"before a Kali-capable specialist calls its model",
			"keeps the running Container awake during active work",
			"30-minute inactivity timeout",
			"Scratch files and live processes are not durable",
			"Workspace/result and Artifacts publication paths",
			"Retain operation/session IDs",
			"reconcile unknown outcomes before any mutation retry",
		} {
			if !strings.Contains(result.Files[name], required) {
				t.Errorf("%s omits the runtime lifetime contract %q", name, required)
			}
		}
	}
	for name, content := range result.Files {
		if !strings.HasSuffix(name, ".md") {
			continue
		}
		for _, forbidden := range []string{"existing persistent host", "persistent Kali host", "persistent stock Kali MCP"} {
			if strings.Contains(content, forbidden) {
				t.Errorf("%s retains obsolete Kali persistence advice %q", name, forbidden)
			}
		}
	}
}

func TestEssentialRoleSubstanceIsAlwaysLoaded(t *testing.T) {
	result, err := generate(repository(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, role := range result.Manifest.Roles {
		content := result.Files[role.Role+".md"]
		for _, required := range []string{"## NATIVE EXECUTION CONTRACT", "structured task input", "pentcloud-tools", "## LANGUAGE POLICY", role.ResultTool} {
			if !strings.Contains(content, required) {
				t.Errorf("%s missing %q", role.Role, required)
			}
		}
		for _, forbidden := range []string{"{{", "__CURRENT_TIME__", "__EXECUTION_CONTEXT__", "__USER_FILES__", "__CWD__", "[summary]", "Default: 120 seconds (Hard limit: 20 minutes)", "detach=true", "stores ALL previous", "any non-English query retrieves nothing", "graphiti_search"} {
			if strings.Contains(content, forbidden) {
				t.Errorf("%s retains obsolete runtime instruction %q", role.Role, forbidden)
			}
		}
	}
	for role, required := range map[string][]string{
		"primary":     {"PLANNING & REASONING PROTOCOL", "Task Boundaries", "COMPREHENSIVE results", "CUSTOMER INTERACTION PROTOCOL"},
		"reporter":    {"EVALUATION METHODOLOGY", "REPORT FORMULATION CRITERIA", "CRITICAL EVALUATION PRINCIPLES", "12000 characters"},
		"adviser":     {"OPERATIONAL MODES", "ADVISORY COMMUNICATION STYLE", "KNOWLEDGE DISCOVERY PROTOCOL", "DATA INTERPRETATION"},
		"coder":       {"KNOWLEDGE MANAGEMENT", "HISTORICAL CONTEXT RETRIEVAL", "ANONYMIZE", "usage examples"},
		"maintenance": {"SOFTWARE INSTALLATION PROTOCOL", "dependency", "COMPLETION REQUIREMENTS"},
		"memorist":    {"precise", "HISTORICAL CONTEXT RETRIEVAL", "GOOD queries", "BAD queries"},
		"pentester":   {"KNOWLEDGE MANAGEMENT", "ANONYMIZE", "exploitation details", "HISTORICAL CONTEXT RETRIEVAL"},
		"searcher":    {"CORE CAPABILITIES", "OPERATIONAL PROTOCOLS", "SEARCH RESULT DELIVERY"},
	} {
		for _, text := range required {
			if !strings.Contains(result.Files[role+".md"], text) {
				t.Errorf("%s lost substantive requirement %q", role, text)
			}
		}
	}
}
