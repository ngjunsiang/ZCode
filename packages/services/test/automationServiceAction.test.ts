// fork Auto-Resume（.fork/spec-auto-resume.md N8）：resumeTurn 动作的 service 校验 +
// 会话生命周期清理 API + repo action 列读写/迁移归一。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
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
    assert.equal(created.action, "resumeTurn");
    assert.equal(created.prompt, "");
    assert.equal(created.recurring, false);
    assert.equal(created.targetTaskId, "task-1");
    assert.equal(created.modelSelection, undefined);
    assert.ok(created.nextRunAt ?? 0 > NOW - 1);
  });

  it("创建拒绝：缺绑定 / 循环 / 固定模型 / 携带提示词 / 自定义规则", async () => {
    await assert.rejects(service.create(makeResumeParams({ targetTaskId: undefined })), InvalidAutomationActionError);
    await assert.rejects(service.create(makeResumeParams({ recurring: true })), InvalidAutomationActionError);
    await assert.rejects(service.create( makeResumeParams({ modelSelection: { providerId: "p", modelId: "m" }, }), ), InvalidAutomationActionError);
    await assert.rejects(service.create(makeResumeParams({ prompt: "do things" })), InvalidAutomationActionError);
    await assert.rejects(service.create( makeResumeParams({ relativeDelayMinutes: undefined, scheduleRule: { unit: "daily", interval: 1, hour: 9, minute: 0, anchorAt: NOW, }, }), ), InvalidAutomationActionError);
  });

  it("编辑：仅允许标题；调度/提示词等定义字段被拒", async () => {
    const created = await service.create(makeResumeParams());
    assert.equal((await service.update(created.automationId, { title: "新标题" }))?.title, 
      "新标题",
    );
    await assert.rejects(service.update(created.automationId, { prompt: "x" }), InvalidAutomationActionError);
    await assert.rejects(service.update(created.automationId, { cronExpr: "0 9 * * *" }), InvalidAutomationActionError);
    await assert.rejects(service.update(created.automationId, { recurring: true }), InvalidAutomationActionError);
  });

  it("prompt 动作回归：无 action 的旧调用仍要求提示词、默认无限循环", async () => {
    const created = await service.create({
      title: "每日巡检",
      cronExpr: "0 9 * * *",
      prompt: "巡检",
      workspacePath: "/tmp/ws",
      recurring: true,
    });
    assert.equal(created.action, "prompt");
    assert.equal(created.recurring, true);
    await assert.rejects(
      service.create({
        title: "无提示词",
        cronExpr: "0 9 * * *",
        workspacePath: "/tmp/ws",
        recurring: true,
      }),
      /提示词不能为空/,
    );
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
    assert.equal(await repo.deleteResumeTurnByTargetTask("task-1", "/tmp/ws"), 1);
    const rest = await service.list({ workspacePath: "/tmp/ws" });
    assert.equal(rest.length, 2);
    assert.equal(rest.every((item) => item.targetTaskId !== "task-1" || item.action === "prompt"), 
      true,
    );
  });

  it("历史行兼容：0004 补列后旧行读作 prompt；库重开迁移可重放", async () => {
    // repo 惰性建库：先确保 schema 存在，再造「0004 已回退」的库（删 action 列 + 删 0004 账本行）。
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
    raw.exec("DELETE FROM tasks_schema_migration WHERE id='0004_automation_action'");
    raw.close();
    // 旧进程内标记不跨实例：新 repo 重开时账本缺 0004 → 迁移补列，旧行按 DEFAULT 'prompt' 回填。
    const reopened = new AutomationRepo(dbPath);
    try {
      const legacy = await reopened.get("legacy-1");
      assert.equal(legacy?.action, "prompt");
      assert.equal(legacy?.prompt, "正文");
      const created = await reopened.create(makeResumeParams(), { nextRunAt: NOW + MINUTE });
      assert.equal(created.action, "resumeTurn");
    } finally {
      reopened.close();
    }
  });
});
