import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ReactNode } from "react";

/** A Frost panel over the dimmed page; the web app's dialog draws its own glass and shadow. */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-canvas/60 backdrop-blur-sm" />
        <DialogPrimitive.Viewport className="fixed inset-0 z-50 flex items-center justify-center sm:p-4">
          <DialogPrimitive.Popup className="panel w-full max-w-lg space-y-4 bg-white p-6 text-ink shadow-sm shadow-black/5 outline-none">
            <div className="space-y-1">
              <DialogPrimitive.Title className="font-title text-lg font-bold tracking-tight">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="text-sm text-ink-muted">
                {description}
              </DialogPrimitive.Description>
            </div>
            {children}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
