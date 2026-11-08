import { Streamdown, type Components } from "streamdown";
import "streamdown/styles.css";
import { ExternalLink } from "./external-link";

// Keep Markdown formatting and code, but never render network-bearing HTML.
const elements = [
  "p",
  "br",
  "hr",
  "div",
  "span",
  "a",
  "img",
  "strong",
  "em",
  "del",
  "s",
  "b",
  "i",
  "u",
  "sub",
  "sup",
  "blockquote",
  "pre",
  "code",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "input",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td"
];
const components: Components = {
  img: ({ alt }) => (
    <span className="text-base text-kumo-subtle">
      [Image hidden{alt ? `: ${alt}` : ""}. Use cloud browser screenshots or run
      files.]
    </span>
  ),
  a: ({ href, children }) => <ExternalLink href={href}>{children}</ExternalLink>
};
export function ChatMarkdown({
  children,
  streaming = false
}: {
  children: string;
  streaming?: boolean;
}) {
  return (
    <Streamdown
      controls={{
        code: { copy: true, download: false },
        table: { copy: true, download: false, fullscreen: false },
        mermaid: false
      }}
      allowedElements={elements}
      components={components}
      animated={streaming}
      isAnimating={streaming}
      {...(streaming ? { caret: "block" as const } : {})}
    >
      {children}
    </Streamdown>
  );
}
