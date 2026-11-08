import { Button, InputArea } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";

export interface PromptEditorProps {
  roleLabel: string;
  value: string;
  upstreamDigest: string;
  revision: string;
  disabled: boolean;
  canReset: boolean;
  onChange: (value: string) => void;
  onReset: () => void;
}

export function PromptEditor(props: PromptEditorProps) {
  return (
    <section className="settings-prompt-card">
      <div className="settings-editor-meta">
        <span>{props.value.length.toLocaleString()} characters</span>
        <span title={props.upstreamDigest}>
          Upstream {props.upstreamDigest.slice(0, 8)}
        </span>
        <span title={props.revision}>
          Revision {props.revision.slice(0, 8)}
        </span>
        <Button
          variant="ghost"
          size="base"
          icon={<ArrowCounterClockwiseIcon size={14} />}
          disabled={props.disabled || !props.canReset}
          onClick={props.onReset}
        >
          Reset to default
        </Button>
      </div>
      <InputArea
        className="settings-prompt-editor"
        aria-label={`${props.roleLabel} prompt template`}
        spellCheck={false}
        value={props.value}
        disabled={props.disabled}
        onValueChange={props.onChange}
      />
    </section>
  );
}
