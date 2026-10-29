// fork Auto-Resume（.fork/spec-auto-resume.md N8）：resumeTurn 动作的 service 校验 +
// 会话生命周期清理 API + repo action 列读写/迁移归一。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutomationRepo } from "../src/session/automationRepo.js";
import {
  AutomationService,
  InvalidAutomationActionError,
} from "../src/session/automationService.js";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function makeResumeParams(overrides: Record<string, unknown> = {}) {
  return {
    title: "Auto-Resume · 配额中断会话",
    cronExpr: "* * * * *",
    action: "resumeTurn" as const,
    targetTaskId: "task-1",
    relativeDelayMinutes: 30,
    recurring: false,
    workspacePath: "/tmp/ws",
    ...overrides,
  };
}

describe("AutomationService resumeTurn 动作", () => {
  let tempDir: string | null = null;
  let dbPath: string;
  let repo: AutomationRepo;
  let service: AutomationService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-automation-action-"));
    dbPath = join(tempDir, "tasks-index.sqlite");
    repo = new AutomationRepo(dbPath);
    service = new AutomationService(repo);
  });

  afterEach(() => {
    repo.close();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("创建：resumeTurn 一次性落库，prompt 归一空串，绑定 targetTaskId", async () => {
    const created = await service.create(makeResumeParams());
    expect(created.action).toBe("resumeTurn");
    expect(created.prompt).toBe("");
    expect(created.recurring).toBe(false);
    expect(created.targetTaskId).toBe("task-1");
    expect(created.modelSelection).toBeUndefined();
    expect(created.nextRunAt ?? 0).toBeGreaterThan(NOW - 1);
  });

  it("创建拒绝：缺绑定 / 循环 / 固定模型 / 携带提示词 / 自定义规则", async () => {
    await expect(
      service.create(makeResumeParams({ targetTaskId: undefined })),
    ).rejects.toBeInstanceOf(InvalidAutomationActionError);
    await expect(service.create(makeResumeParams({ recurring: true }))).rejects.toBeInstanceOf(
      InvalidAutomationActionError,
    );
    await expect(
      service.create(
        makeResumeParams({
          modelSelection: { providerId: "p", modelId: "m" },
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidAutomationActionError);
    await expect(service.create(makeResumeParams({ prompt: "do things" }))).rejects.toBeInstanceOf(
      InvalidAutomationActionError,
    );
    await expect(
      service.create(
        makeResumeParams({
          relativeDelayMinutes: undefined,
          scheduleRule: {
            unit: "daily",
            interval: 1,
            hour: 9,
            minute: 0,
            anchorAt: NOW,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidAutomationActionError);
  });

  it("编辑：仅允许标题；调度/提示词等定义字段被拒", async () => {
    const created = await service.create(makeResumeParams());
    expect((await service.update(created.automationId, { title: "新标题" }))?.title).toBe("新标题");
    await expect(service.update(created.automationId, { prompt: "x" })).rejects.toBeInstanceOf(
      InvalidAutomationActionError,
    );
    await expect(
      service.update(created.automationId, { cronExpr: "0 9 * * *" }),
    ).rejects.toBeInstanceOf(InvalidAutomationActionError);
    await expect(service.update(created.automationId, { recurring: true })).rejects.toBeInstanceOf(
      InvalidAutomationActionError,
    );
  });

  it("prompt 动作回归：无 action 的旧调用仍要求提示词、默认无限循环", async () => {
    const created = await service.create({
      title: "每日巡检",
      cronExpr: "0 9 * * *",
      prompt: "巡检",
      workspacePath: "/tmp/ws",
      recurring: true,
    });
    expect(created.action).toBe("prompt");
    expect(created.recurring).toBe(true);
    await expect(
      service.create({
        title: "无提示词",
        cronExpr: "0 9 * * *",
        workspacePath: "/tmp/ws",
        recurring: true,
      }),
    ).rejects.toThrow("提示词不能为空");
  });

  it("清理 API：按绑定会话删 resumeTurn，不碰 prompt 动作的绑定", async () => {
    await service.create(makeResumeParams());
    await service.create(
      makeResumeParams({ targetTaskId: "task-2", title: "Auto-Resume · 另一会话" }),
    );
    // 会话内 CronCreate 的 prompt 绑定不受清理影响。
    await service.create({
      title: "会话内定时",
      cronExpr: "*/5 * * * *",
      prompt: "巡检",
      targetTaskId: "task-1",
      workspacePath: "/tmp/ws",
      recurring: true,
    });
    expect(await repo.deleteResumeTurnByTargetTask("task-1", "/tmp/ws")).toBe(1);
    const rest = await service.list({ workspacePath: "/tmp/ws" });
    expect(rest).toHaveLength(2);
    expect(rest.every((item) => item.targetTaskId !== "task-1" || item.action === "prompt")).toBe(
      true,
    );
  });

  it("历史行兼容：0007 补列后旧行读作 prompt；库重开迁移可重放", async () => {
    // repo 惰性建库：先确保 schema 存在，再造「0007 已回退」的库（删 action 列 + 删 0007 账本行）。
    await repo.ensureReady();
    const raw = new DatabaseSync(dbPath);
    raw.exec(
      `INSERT INTO automations (automation_id, title, cron_expr, prompt, action, workspace_key,
        workspace_path, location_kind, recurring, schedule_edited_by_user, run_count,
        scheduled_run_count, enabled, lifecycle_status, running, dispatch_status,
        dispatch_attempts, created_at, updated_at)
       VALUES ('legacy-1', '旧行', '* * * * *', '正文', 'prompt', 'ws', '${dbPath}', 'local',
        1, 0, 0, 0, 1, 1, 0, 'idle', 0, ${NOW}, ${NOW})`,
    );
    raw.exec("ALTER TABLE automations DROP COLUMN action");
    // fork 迁移在 3.16.2 上重编号为 0007（上游已自带 0004/0006）。
    raw.exec("DELETE FROM tasks_schema_migration WHERE id='0007_automation_action'");
    raw.close();
    // 旧进程内标记不跨实例：新 repo 重开时账本缺 0007 → 迁移补列，旧行按 DEFAULT 'prompt' 回填。
    const reopened = new AutomationRepo(dbPath);
    try {
      const legacy = await reopened.get("legacy-1");
      expect(legacy?.action).toBe("prompt");
      expect(legacy?.prompt).toBe("正文");
      const created = await reopened.create(makeResumeParams(), { nextRunAt: NOW + MINUTE });
      expect(created.action).toBe("resumeTurn");
    } finally {
      reopened.close();
    }
  });
});
