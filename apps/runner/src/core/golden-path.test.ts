import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildGoldenPathPrompt } from "./golden-path.js";

function makeTask(inputObj: Record<string, unknown>) {
  const now = Date.now();
  return {
    _id: "t_test",
    _creationTime: now,
    squadId: "s_test",
    runId: "r_test",
    goal: "Test task",
    type: "playbook-agent",
    status: "todo",
    input: JSON.stringify(inputObj),
    source: "intake",
    workflow: "product-development",
    updatedAt: now,
  } as const;
}

describe("golden path prompt assembly", () => {
  it("builds prompt from globalContext files + selected skill", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-gp-"));
    await mkdir(path.join(repoRoot, ".flux", "skills"), { recursive: true });

    await writeFile(path.join(repoRoot, "CLAUDE.md"), "Repo: {OWNER}/{REPO}\n");
    await writeFile(path.join(repoRoot, ".flux", "preamble.md"), "Status: {ISSUE_STATUS}\n");
    await writeFile(
      path.join(repoRoot, ".flux", "skills", "00-groom.md"),
      "Write hello world for issue #{ISSUE_NUMBER}\n",
    );

    await writeFile(
      path.join(repoRoot, ".flux", "golden-path.yaml"),
      [
        "contractVersion: 3",
        "resourceType: issue",
        "globalContext:",
        "  files:",
        "    - CLAUDE.md",
        "    - .flux/preamble.md",
        "  onMissingFile: fail",
        "lifecycle:",
        "  - key: groom",
        "    statuses:",
        "      - name: Groom",
        "        id: null",
        "    skill: .flux/skills/00-groom.md",
        "",
      ].join("\n"),
      "utf-8",
    );

    const task = makeTask({
      intake: {
        resourceId: "acme/widgets#123",
        resourceUpdatedAt: "2026-02-13T00:00:00Z",
        externalStatus: "Groom",
      },
      node: { key: "execute", title: "Execute" },
    });

    const result = await buildGoldenPathPrompt({
      task,
      repoRoot,
      repo: { owner: "acme", repo: "widgets", repoPath: repoRoot },
      externalStatus: "Groom",
      nodeKey: "execute",
    });

    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") {
      throw new Error("expected mapped golden path prompt");
    }
    expect(result.stageKey).toBe("groom");
    expect(result.skillRelPath).toBe(".flux/skills/00-groom.md");
    expect(result.prompt).toContain("Repo: acme/widgets");
    expect(result.prompt).toContain("Status: Groom");
    expect(result.prompt).toContain("issue #123");
  });

  it("returns noop when status is unmapped", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-gp-"));
    await mkdir(path.join(repoRoot, ".flux", "skills"), { recursive: true });
    await writeFile(
      path.join(repoRoot, ".flux", "golden-path.yaml"),
      [
        "contractVersion: 1",
        "resourceType: issue",
        "lifecycle:",
        "  - key: groom",
        "    statuses:",
        "      - name: Groom",
        "        id: null",
        "    skill: .flux/skills/00-groom.md",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(path.join(repoRoot, ".flux", "skills", "00-groom.md"), "ok\n", "utf-8");

    const task = makeTask({ intake: { resourceId: "acme/widgets#1", externalStatus: "Foo" } });
    const result = await buildGoldenPathPrompt({
      task,
      repoRoot,
      repo: { owner: "acme", repo: "widgets", repoPath: repoRoot },
      externalStatus: "Foo",
    });
    expect(result.kind).toBe("noop");
  });

  it("returns missing when repo has no golden-path.yaml", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-gp-"));
    const task = makeTask({ intake: { resourceId: "acme/widgets#1", externalStatus: "Groom" } });
    const result = await buildGoldenPathPrompt({
      task,
      repoRoot,
      repo: { owner: "acme", repo: "widgets", repoPath: repoRoot },
      externalStatus: "Groom",
    });
    expect(result.kind).toBe("missing");
  });

  it("rejects skill paths that escape .flux/skills", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-gp-"));
    await mkdir(path.join(repoRoot, ".flux", "skills"), { recursive: true });
    await writeFile(
      path.join(repoRoot, ".flux", "golden-path.yaml"),
      [
        "contractVersion: 1",
        "resourceType: issue",
        "lifecycle:",
        "  - key: groom",
        "    statuses:",
        "      - name: Groom",
        "        id: null",
        "    skill: ../README.md",
        "",
      ].join("\n"),
      "utf-8",
    );
    await expect(
      buildGoldenPathPrompt({
        task: makeTask({ intake: { resourceId: "acme/widgets#1", externalStatus: "Groom" } }),
        repoRoot,
        repo: { owner: "acme", repo: "widgets", repoPath: repoRoot },
        externalStatus: "Groom",
      }),
    ).rejects.toThrow(/escapes repo root|skills/);
  });
});
