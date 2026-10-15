import { useCallback, useState } from "react";
import type { OAuthAccountSummary } from "@zcode/shared";
import { resolveProviderFamilyDomainFromOAuthProvider } from "@zcode/shared";
import { setProviderFamilyDomain } from "@/lib/providerFamilyDomainSettings.js";
import { refreshLatestModelProviderFamilySelectionAfterLogin } from "@/root/oauthProviderFamilySelectionRefresh.js";
import { refreshRootProviderState } from "@/root/useRootProviderStateRefresh.js";
import { handleOAuthCallbackSuccess } from "@/root/useRootOAuthEffects.js";
import { logger } from "@/logger.js";
import { usePlatform } from "./usePlatform.js";
import { useServices } from "./useServices.js";
import { useSettings } from "./useSettingService.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

/**
 * hydra 账号切换器数据源（sidebar footer 账号切换按钮/弹层专用）。
 *
 * switchTo 调 host 的 switchAccount 事务（冻结 outgoing → 激活目标 → 解冻其
 * token 副本），成功后复用 OAuth 登录成功的 renderer 刷新序列（user、
 * provider family、settings 快照、Provider Runtime），保证套餐、额度与模型
 * 可用态立即跟随新账号，而不是等下次启动恢复才收敛。
 */
export function useAccountSwitcher() {
  const services = useServices();
  const platform = usePlatform();
  const { refresh: refreshAppSettings } = useSettings();
  const setUser = useZCodeStore((state) => state.setUser);
  const setOAuthError = useZCodeStore((state) => state.setOAuthError);
  const [accounts, setAccounts] = useState<OAuthAccountSummary[]>([]);
  const [isSwitching, setIsSwitching] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setAccounts(await services.oauthService.listAccounts());
    } catch (error) {
      // 列表读取失败只影响切换器展示，不影响账号态本身
      logger.warn("[AccountSwitcher] 读取账号列表失败:", error);
      setAccounts([]);
    }
  }, [services.oauthService]);

  const switchTo = useCallback(
    async (account: OAuthAccountSummary): Promise<boolean> => {
      setIsSwitching(true);
      try {
        await services.oauthService.switchAccount(account.provider, account.accountId);
      } catch (error) {
        // 切换事务失败：本地账号态未变，提示后保持原账号
        logger.warn("[AccountSwitcher] 切换账号失败:", error);
        setIsSwitching(false);
        return false;
      }
      try {
        await handleOAuthCallbackSuccess({
          result: {
            kind: "session",
            provider: account.provider,
            userInfo: {
              id: account.accountId,
              username: account.username,
              displayName: account.displayName,
              ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}),
            },
          },
          platform,
          refreshLatestModelProviderFamilySelection: (provider) =>
            refreshLatestModelProviderFamilySelectionAfterLogin({ provider, services }),
          refreshAppSettings,
          refreshProviderState: () => refreshRootProviderState(services),
          setProviderFamilyDomain: async (provider) => {
            const domain = resolveProviderFamilyDomainFromOAuthProvider(provider);
            if (domain) {
              await setProviderFamilyDomain(services.settingService, domain);
            }
          },
          setUser,
          setOAuthError,
          // 切换不是登录：遥测事件区分开，避免污染登录漏斗数据
          successTelemetryElementName: "app_account_switch",
        });
      } catch (error) {
        // 切换已在 host 落盘；展示态刷新失败等下次启动恢复收敛
        logger.warn("[AccountSwitcher] 切换后刷新展示态失败:", error);
      } finally {
        setIsSwitching(false);
      }
      return true;
    },
    [platform, refreshAppSettings, services, setOAuthError, setUser],
  );

  return { accounts, isSwitching, refresh, switchTo };
}
