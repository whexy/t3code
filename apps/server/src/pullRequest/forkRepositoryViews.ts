import type { OrchestrationProjectShell, RepositoryIdentity } from "@t3tools/contracts";

import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";

// A fork's identity is its upstream; its own pull requests are on origin. Only a fork on the
// upstream's host is read, because it shares the upstream's provider and credentials.
function forkIdentityOf(
  identity: RepositoryIdentity | null | undefined,
): RepositoryIdentity | null {
  const fork = identity?.origin;
  if (!identity || fork?.remoteUrl === undefined) return null;
  const upstreamHost = sourceControlDefinitions.recognizeRemote(identity.locator.remoteUrl);
  const forkHost = sourceControlDefinitions.recognizeRemote(fork.remoteUrl);
  if (upstreamHost === null || forkHost?.baseUrl !== upstreamHost.baseUrl) return null;
  const segments = (fork.displayName ?? "").split("/").filter((segment) => segment.length > 0);
  const [owner] = segments;
  const name = segments.at(-1);
  return {
    canonicalKey: fork.canonicalKey,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: fork.remoteUrl },
    ...(identity.rootPath ? { rootPath: identity.rootPath } : {}),
    ...(fork.displayName ? { displayName: fork.displayName } : {}),
    ...(identity.provider ? { provider: identity.provider } : {}),
    ...(owner ? { owner } : {}),
    ...(name ? { name } : {}),
  };
}

interface RepositoryView {
  readonly project: OrchestrationProjectShell;
  readonly upstream: boolean;
}

// The fork's own view comes first, so a project reading both repositories is listed by its fork.
export const repositoryViewsOf = (
  project: OrchestrationProjectShell,
): ReadonlyArray<RepositoryView> => {
  const fork = forkIdentityOf(project.repositoryIdentity);
  return fork === null
    ? [{ project, upstream: false }]
    : [
        { project: { ...project, repositoryIdentity: fork }, upstream: false },
        { project, upstream: true },
      ];
};
