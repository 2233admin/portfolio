// The project has no @types/react-dom; this is all the preview page needs from it.
declare module "react-dom/client" {
    import type { ReactNode } from "react";
    export function createRoot(el: Element): { render(node: ReactNode): void };
}
