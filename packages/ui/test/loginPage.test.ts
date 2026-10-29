import { describe, expect, it } from "vitest";

describe("WelcomeScreen", () => {
  it("已有用户不会完成新发起的 Provider 登录尝试", async () => {
    const { shouldCompleteLoginFromExistingUser, shouldCompleteProviderLoginAttempt } =
      await import("@/WelcomeScreen.js");
    const attempt = { id: 9, providerId: "bigmodel" as const };

    expect(shouldCompleteLoginFromExistingUser({ hasUser: true, attempt })).toBe(false);
    expect(shouldCompleteProviderLoginAttempt({ attempt, successProvider: "zai" })).toBe(false);
    expect(shouldCompleteProviderLoginAttempt({ attempt, successProvider: "bigmodel" })).toBe(true);
  });

  it("hydra: 已登录时打开登录入口不立即完成，user 从无到有才完成", async () => {
    const { shouldCompleteLoginEntryOnUserAppeared } = await import("@/WelcomeScreen.js");
    const attempt = null;

    // Add account：打开入口时 user 已存在，激活帧本身不关闭
    expect(
      shouldCompleteLoginEntryOnUserAppeared({
        userPresentAtEntry: true,
        isUserPresent: true,
        attempt,
      }),
    ).toBe(false);

    // 登出态打开入口，登录成功后 user 出现 → 自动关闭（原有行为保留）
    expect(
      shouldCompleteLoginEntryOnUserAppeared({
        userPresentAtEntry: false,
        isUserPresent: true,
        attempt,
      }),
    ).toBe(true);

    // user 一直在（无变化）不触发；带 provider 登录尝试时仍由 attempt 规则裁决
    expect(
      shouldCompleteLoginEntryOnUserAppeared({
        userPresentAtEntry: true,
        isUserPresent: false,
        attempt,
      }),
    ).toBe(false);
    expect(
      shouldCompleteLoginEntryOnUserAppeared({
        userPresentAtEntry: false,
        isUserPresent: true,
        attempt: { id: 1, providerId: "bigmodel" as const },
      }),
    ).toBe(false);
  });
});
