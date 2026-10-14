# 桌面构建期可选能力

## 目标

四项能力由构建期配置决定：

| 能力 | 配置项 | 未配置时的默认 | 关闭时的行为 |
| --- | --- | --- | --- |
| ARMS RUM 上报 | `ZCODE_ARMS_RUM_ENDPOINT` | 关闭 | 主进程与渲染进程的 ARMS SDK 以 `enable: false` 初始化，不产生上报 |
| 事件上报（数仓） | `ZCODE_TELEMETRY_REPORT_ENDPOINT` | 关闭 | 遥测事件在发送前直接返回 |
| 自动更新 | `ZCODE_AUTO_UPDATE`（`1`、`true`、`yes` 为启用） | 关闭 | 与 Preview 形态相同，不检查、不下载更新 |
| 远端强更门 | `ZCODE_FORCE_UPDATE_GUARD`（`1` 开 / `0` 关，其它拼写构建期失败） | **开启** | 启动期不再请求 `/client/configs`，服务端 `minimalVersion` 不能硬锁一个没有自更新通道的构建 |

这样同一份源码可以产出“默认不上报、不自动更新”的构建，也可以产出启用这些能力的正式构建，
不需要在源码里写死上报地址。

强更门与前三项极性相反：它面向的是「能自己更新的发布客户端」的安全门，默认必须保持开启；
只有升级所有权不在应用自身（如包管理器分发的 fork 发布线）的构建才应显式传 `0` 关闭。

## 配置来源与优先级

1. 构建进程的环境变量。三项上报能力显式设置为空字符串表示关闭；`ZCODE_FORCE_UPDATE_GUARD` 只接受 `1`/`0`，空字符串等价于未配置（保持默认开启）。
2. `config/private/build-defaults.json`。只存在于内部仓库，开源导出不包含。
3. 以上都没有时：三项上报能力关闭，强更门开启。

## 所有者与数据流

```
环境变量 / config/private/build-defaults.json
        │ scripts/build-time-config.mjs（唯一解析入口）
        ▼
desktop tsup（main、host、preload）与 desktop vite（renderer）的 define
        │ __ZCODE_ARMS_RUM_ENDPOINT__ / __ZCODE_TELEMETRY_REPORT_ENDPOINT__ / __ZCODE_AUTO_UPDATE_ENABLED__ / __ZCODE_FORCE_UPDATE_GUARD_ENABLED__
        ▼
@zcode/shared env 常量 ── 运行时代码只读这些常量
```

- 未注入 define 的环境（测试、其他 bundle）得到关闭值（强更门相反，得到开启值）；vitest 为测试注入固定的事件上报端点，以便验证上报链路。
- 自动更新在 Desktop Main 启动时判定：`ZCODE_PRODUCT_FLAVOR === "production" && ZCODE_AUTO_UPDATE_ENABLED`。
- 强更门在 Desktop Main 启动时判定：`ZCODE_PRODUCT_FLAVOR === "production" && ZCODE_FORCE_UPDATE_GUARD_ENABLED && app.isPackaged`；任一条件不满足即跳过远端检查（与现有 Preview / dev 跳过同一出口，只少一次 `/client/configs` 请求，无状态差异）。
- Agent 的 OTLP 遥测沿用既有机制，由打包环境的 `ZCODE_PACKAGED_AGENT_OTEL_*` 注入，不在本文件范围内。

## 验收

1. 内部仓库存在私有默认配置时，构建结果与改造前一致：ARMS、事件上报、自动更新均启用，地址不变，强更门开启。
2. 没有私有默认配置、也没有环境变量时，三项上报能力关闭，强更门开启。
3. 环境变量优先于私有默认配置，显式空字符串可以关闭单项上报能力。
4. `ZCODE_FORCE_UPDATE_GUARD` 只接受 `1`/`0`；未配置默认开启，其它拼写构建期直接失败（默认值在开启一侧，静默吞掉未知拼写会让试图关门的发布构建带门出包）。
5. 类型检查、Lint 与相关单测通过。
