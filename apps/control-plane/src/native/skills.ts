import { Skill } from "@opencode/plugin";
import tools from "./specialists/tools.md?raw";
import toolPacks from "./specialists/tool-packs.md?raw";
import { digest } from "./domain";

export interface PinnedToolSkill {
  content: string;
  digest: string;
}
export async function pinToolSkill(packages = false): Promise<PinnedToolSkill> {
  const content = packages ? toolPacks : tools;
  return { content, digest: await digest(content) };
}
/** A flat embedded skill avoids local discovery and SKILL.md directory scanning. */
export function embeddedToolSkill(skill: PinnedToolSkill): Skill.Info {
  return Skill.Info.make({
    id: Skill.ID.make("pentcloud-tools"),
    name: Skill.Name.make("PentCloud tool procedures"),
    description:
      "Use the supplied Computer, Browser, Git memory and installed scanner tools correctly when performing a specialist task.",
    path: "/workspace/.opencode/skills/pentcloud-tools.md" as Skill.Info["path"],
    content: skill.content
  });
}
