import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeRawThreadShell, makeThreadShellFixture } from "../../test-fixtures";
import { deriveSuperThreadList } from "./superThreadList";

const local = EnvironmentId.make("env-local");
const remote = EnvironmentId.make("env-remote");
const projectA = ProjectId.make("project-a");
const scratch = ProjectId.make("scratch");

function shell(id: string, projectId: ProjectId, environmentId = local) {
  return makeThreadShellFixture({ id: ThreadId.make(id), projectId, environmentId });
}

const header = makeThreadShellFixture({
  id: ThreadId.make("super"),
  projectId: scratch,
  environmentId: local,
  source: makeRawThreadShell({
    id: ThreadId.make("super"),
    projectId: scratch,
    superThread: {
      members: [
        { environmentId: local, threadId: ThreadId.make("a") },
        { environmentId: remote, threadId: ThreadId.make("b") },
      ],
    },
  }),
});
const threads = [
  header,
  shell("a", projectA),
  shell("b", projectA, remote),
  shell("loose", projectA),
];

describe("deriveSuperThreadList", () => {
  it.each([
    {
      name: "claims the header and the members of loaded environments",
      environmentId: null,
      projectRefs: null,
      searchQuery: "",
      loaded: [local],
      rows: [["a"]],
      unclaimed: ["b", "loose"],
    },
    {
      name: "leaves members to the normal list when the project filter hides the header",
      environmentId: null,
      projectRefs: [
        { environmentId: local, projectId: projectA },
        { environmentId: remote, projectId: projectA },
      ],
      searchQuery: "",
      loaded: [local, remote],
      rows: [],
      unclaimed: ["super", "a", "b", "loose"],
    },
    {
      name: "keeps a member of a filtered-out environment in the normal list",
      environmentId: local,
      projectRefs: null,
      searchQuery: "",
      loaded: [local, remote],
      rows: [["a"]],
      unclaimed: ["b", "loose"],
    },
    {
      name: "lists search matches flat",
      environmentId: null,
      projectRefs: null,
      searchQuery: "api",
      loaded: [local, remote],
      rows: [],
      unclaimed: ["super", "a", "b", "loose"],
    },
  ])("$name", ({ environmentId, projectRefs, searchQuery, loaded, rows, unclaimed }) => {
    const result = deriveSuperThreadList({
      threads,
      environmentId,
      projectRefs,
      searchQuery,
      loadedEnvironmentIds: new Set(loaded),
    });
    expect(result.sections.map((section) => section.rows.map((row) => row.id))).toEqual(rows);
    expect(result.unclaimedThreads.map((thread) => thread.id)).toEqual(unclaimed);
  });
});
