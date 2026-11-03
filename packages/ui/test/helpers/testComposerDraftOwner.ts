import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import type { ComposerDraftContent } from "@/v4/composer/useDraftConfigControl.js";

/**
 * 测试自持的 3.16.3 草稿 owner：镜像 useDraftConfigControl 的 staged-content +
 * scope incarnation + submission draft transaction 语义（省略 workspace 持久层细节）。
 * ConversationComposer 的测试挂载点用它替换旧的「裸 composerDraft + updateComposerContent」注入，
 * 使提交/恢复/结算用例走真实的收口路径。
 *
 * sink：所有「落草稿 store」的写转（claim 清空 / restore 回填 / finalize 结算 / 生命周期收口）
 * 优先走 setSink 注入的观察器（tests 据此断言 store 写入序列）；未注入时落到 persist。
 * stageComposerContent 只进内存 staged buffer（与实现一致，不触发 store 写入），
 * 在 finalize / lifecycle commit 时并入并落盘。
 */
export function createTestComposerDraftOwner(options: {
  initialDraft?: V4ComposerDraft;
  persist?: (draft: V4ComposerDraft) => void;
} = {}) {
  let draft: V4ComposerDraft = options.initialDraft ?? { text: "", updatedAt: 0 };
  let revision = 0;
  let staged: { content: ComposerDraftContent } | null = null;
  let sink: ((content: ComposerDraftContent) => void) | null = null;
  const scopeToken = Symbol("test-composer-draft-scope");

  const notifyWrite = (next: V4ComposerDraft) => {
    draft = { ...next, updatedAt: Date.now() };
    const content = {
      text: draft.text,
      editorStateJson: draft.editorStateJson,
      mention: draft.mention,
    };
    if (sink) sink(content);
    else options.persist?.(draft);
    return draft;
  };

  const owner = {
    get draft(): V4ComposerDraft {
      return draft;
    },
    get revision(): number {
      return revision;
    },
    composerDraftScopeToken: scopeToken,
    setSink(next: ((content: ComposerDraftContent) => void) | null) {
      sink = next;
    },
    stageComposerContent: (content: ComposerDraftContent) => {
      draft = { ...draft, editorStateJson: undefined, mention: undefined, ...content };
      revision += 1;
      staged = { content };
    },
    persistComposerContent: (content: ComposerDraftContent) => {
      draft = { ...draft, editorStateJson: undefined, mention: undefined, ...content };
      revision += 1;
      staged = { content };
      notifyWrite(draft);
    },
    updateComposerContent: (content: ComposerDraftContent) => {
      draft = { ...draft, editorStateJson: undefined, mention: undefined, ...content };
      revision += 1;
      notifyWrite(draft);
    },
    captureComposerContentLifecycleCommit: () => {
      let active = true;
      return (content: ComposerDraftContent) => {
        if (!active) return;
        active = false;
        draft = { ...draft, editorStateJson: undefined, mention: undefined, ...content };
        revision += 1;
        staged = null;
        notifyWrite(draft);
      };
    },
    captureComposerSubmissionDraftTransaction: (content: ComposerDraftContent) => {
      const submittedContent = {
        text: content.text,
        editorStateJson: content.editorStateJson,
        mention: content.mention,
      };
      const capturedRevision = revision;
      let state: "captured" | "claimed" | "restored" | "finalized" = "captured";
      let claimedRevision: number | null = null;
      let restoredRevision: number | null = null;
      const unchangedSince = (expected: number | null) =>
        expected !== null && revision === expected;
      return {
        matchesTarget: (candidate: symbol) => candidate === scopeToken,
        claim: () => {
          if (state !== "captured" || revision !== capturedRevision) return false;
          draft = { ...draft, text: "", editorStateJson: undefined, mention: undefined };
          revision += 1;
          claimedRevision = revision;
          state = "claimed";
          staged = null;
          notifyWrite(draft);
          return true;
        },
        restore: () => {
          if (state !== "claimed" || claimedRevision === null) {
            return { current: unchangedSince(claimedRevision), applied: false };
          }
          staged = null;
          if (unchangedSince(claimedRevision)) {
            draft = { ...draft, ...submittedContent };
            revision += 1;
            restoredRevision = revision;
            state = "restored";
            notifyWrite(draft);
            return { current: true, applied: true };
          }
          return { current: false, applied: false };
        },
        release: () => {
          state = "finalized";
        },
        finalize: () => {
          if (state === "finalized") return null;
          // 等待期间的新正文先按 staged buffer 落盘（不并入已提交正文）。
          if (staged) {
            draft = { ...draft, editorStateJson: undefined, mention: undefined, ...staged.content };
            revision += 1;
            notifyWrite(draft);
            staged = null;
          }
          const expectedRevision =
            state === "claimed" ? claimedRevision : state === "restored" ? restoredRevision : null;
          const current = unchangedSince(expectedRevision);
          if (current) {
            draft = { ...draft, text: "", editorStateJson: undefined, mention: undefined };
            revision += 1;
            notifyWrite(draft);
          }
          state = "finalized";
          return { current, applied: current };
        },
      };
    },
  };
  return owner;
}

export type TestComposerDraftOwner = ReturnType<typeof createTestComposerDraftOwner>;
