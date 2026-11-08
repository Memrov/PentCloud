import { Button } from "@cloudflare/kumo";
import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useState } from "react";

export function ThemeControl({ className }: { className?: string }) {
  const [dark, setDark] = useState(
    () =>
      typeof document !== "undefined" &&
      document.documentElement.getAttribute("data-mode") === "dark"
  );
  return (
    <Button
      variant="ghost"
      shape="square"
      {...(className ? { className } : {})}
      icon={dark ? <SunIcon size={17} /> : <MoonIcon size={17} />}
      aria-label="Toggle theme"
      onClick={() => {
        const mode = dark ? "light" : "dark";
        setDark(!dark);
        document.documentElement.setAttribute("data-mode", mode);
        document.documentElement.style.colorScheme = mode;
        localStorage.setItem("theme", mode);
      }}
    />
  );
}
