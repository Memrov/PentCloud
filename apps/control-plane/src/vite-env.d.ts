/// <reference types="vite/client" />

declare module "*.py" {
  const source: string;
  export default source;
}
