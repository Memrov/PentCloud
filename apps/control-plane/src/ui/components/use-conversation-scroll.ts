import { useLayoutEffect, useRef, useState, type UIEvent } from "react";
import type { ChatMessage } from "../presentation";
/** Follow live layout only while the reader remains at the bottom. */
export function useConversationScroll(jobId: string, messages: ChatMessage[]) {
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingBottom = useRef(true);
  useLayoutEffect(() => {
    followingBottom.current = true;
  }, [jobId]);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    // Projection refreshes must preserve file/history inspection. Follow only
    // while the operator is near the bottom, including the initial selection.
    if (scroll && followingBottom.current)
      scroll.scrollTop = scroll.scrollHeight;
  }, [messages, jobId]);

  // Streamdown can finish laying out a code block after the message render.
  // Follow those native size changes only while the reader remains at the bottom.
  useLayoutEffect(() => {
    const scroll = scrollRef.current,
      column = scroll?.firstElementChild;
    if (!scroll || !column) return;
    const observer = new ResizeObserver(() => {
      if (followingBottom.current) scroll.scrollTop = scroll.scrollHeight;
    });
    observer.observe(column);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [jobId]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const scroll = event.currentTarget;
    followingBottom.current =
      scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 48;
    setAwayFromBottom(!followingBottom.current);
  };
  const jumpToLatest = () => {
    followingBottom.current = true;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    setAwayFromBottom(false);
  };
  return { scrollRef, awayFromBottom, onScroll, jumpToLatest };
}
