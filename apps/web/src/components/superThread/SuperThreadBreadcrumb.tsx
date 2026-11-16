import type { ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { NetworkIcon } from "lucide-react";

import { useQuietThreadShell } from "../../state/entities";
import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";

/** A super thread's transcript links back to its page, which the first send skips. */
export function SuperThreadBreadcrumb(props: { readonly threadRef: ScopedThreadRef }) {
  const shell = useQuietThreadShell(props.threadRef);
  if (shell?.source.superThread === undefined) return null;
  return (
    <>
      <WorkspaceBreadcrumbItem className="shrink-0">
        <Link
          to="/super/$superEnvironmentId/$superThreadId"
          params={{
            superEnvironmentId: props.threadRef.environmentId,
            superThreadId: props.threadRef.threadId,
          }}
          className="inline-flex items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <NetworkIcon aria-hidden className="size-3.5" />
          <WorkspaceBreadcrumbText>Super thread</WorkspaceBreadcrumbText>
        </Link>
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator>
        <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
      </WorkspaceBreadcrumbSeparator>
    </>
  );
}
