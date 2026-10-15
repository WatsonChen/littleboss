# M0 引擎評估（草稿）

查證日期：2026-10-15。數字與條款取自各廠商官方頁面（經摘要工具讀取）；付費或承諾前請對照原頁再確認一次。
第三方比較文章只用來找來源，沒有採用其數字。

## 結論（建議，尚待實測）

1. 先拿 F1 到 F11 對 **DBOS Transact（TypeScript）** 實測，再對 **Inngest** 實測，兩者共用同一組測試。
2. **Temporal** 列為備援；若後端之後改用 C#，它升為首選，因為只有它有官方 .NET SDK。
3. 這個順序和原規格（Inngest 優先）不同，原因：DBOS 不需要另一個要連得到的外部服務，狀態放在我們本來就要用的資料庫，
   且訊息有持久保存的保證。這是依文件做的判斷，不是實測結果，實測可能推翻它。

## 已查證的事實

| 項目         | Inngest                                                                                                           | Temporal                                                                                          | DBOS Transact（TS）                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 形態         | 託管服務為主；你的 app 提供 HTTP 端點（`/api/inngest`）給它呼叫，或用 `connect()` 走 WebSocket                    | 需要 Temporal 服務（雲端或自架）加 worker                                                         | 函式庫；狀態存 Postgres，不需另外的服務或訊息佇列                                                                                  |
| 價格         | Free $0：每月 50k executions、5 個並行步驟、事件 256 KiB、單次 run 最長 30 天、追蹤紀錄保留 24 小時。Pro $99/月起 | Cloud 隨用隨付：每百萬 actions $50 起，無月費；試用 $150 額度、90 天。Business 支援加購 $500/月起 | 函式庫免費；選用的管理主控台 Conductor Pro $99/月                                                                                  |
| 授權         | 伺服器為 SSPL（延遲轉為 Apache 2.0）                                                                              | 未查證                                                                                            | MIT                                                                                                                                |
| SDK 語言     | TypeScript、Python、Go、Kotlin/Java；沒有 C#                                                                      | TypeScript、.NET、Java、Go、Python、PHP、Ruby、Rust                                               | TypeScript、Python、Go、Java；沒有列 C#                                                                                            |
| Fastify      | 有官方 Fastify 外掛；NestJS 透過 express 轉接                                                                     | 未查證                                                                                            | 未查證                                                                                                                             |
| 等待外部訊息 | `step.waitForEvent`；文件沒有說明事件早於等待步驟到達時會不會保留                                                 | Signal 寫入事件歷史；handler 可在主流程開始前執行，範例暗示提早的 Signal 仍有效，但文件未明講     | `send` 成功後保證目的 workflow 能 `recv`；訊息持久存放於 Postgres；`recv` 預設逾時 60 秒；從一般程式碼 `send` 要帶 idempotency key |
| 自架         | 單一執行檔加 SQLite 與記憶體 Redis 可跑；`inngest start` 標為 Beta，不保證支援，Postgres 資料不會自動清理         | 未查證                                                                                            | 本來就是自己的程式加 Postgres                                                                                                      |

補充事項：

- Inngest Free 的「execution」= run × (步驟數 + 1)，一個 6 步驟的 run 算 7 次，約可跑 7,000 個 run/月。用完後會暫停，不會自動計費。
- Inngest 平行 `waitForEvent` 輸掉的一方不會被取消，會讓 run 停在 Running 直到逾時。
- Inngest 追蹤紀錄只留 24 小時，所以呼叫紀錄、上下文快照與核准紀錄必須存在我們自己的資料庫（規格本來就這樣要求）。

## 對 little boss 的意義

- 核准存在自己的資料庫，不依賴引擎的事件機制（已實作，見 `apps/api/src/core/approval.ts`）。
  所以 Inngest「事件先到」行為未說明的影響較小，但仍要在 F3 實測。
- 外部寫入一律帶固定的 idempotency key，結果不明時先查證再決定（已實作，見 `external-action.ts`）。
- 若採用 DBOS，需要 Postgres。這需要我們先決定資料庫，目前尚未決定。

## 已實作（不依賴引擎，單元測試層級）

| 案例                     | 狀態                                         |
| ------------------------ | -------------------------------------------- |
| F3 提前核准              | 邏輯與測試完成；尚未驗證跨重啟               |
| F4 重複核准              | 邏輯與測試完成                               |
| F5 舊版本核准            | 邏輯與測試完成                               |
| F7 外部成功但回應中斷    | 邏輯與測試完成（先查證，查不到停在結果不明） |
| F8 重複提交              | 邏輯與測試完成（同一 key 只產生一次效果）    |
| F1、F2、F6、F9、F10、F11 | 需要引擎，尚未開始                           |

目前的核准儲存是記憶體版，只用來測邏輯。換成真正的資料庫後，要再驗證「同時提交只成功一次」。

## 未查證

- Inngest 事件早於等待步驟到達的行為（F3 實測）。
- Temporal 的授權、TypeScript SDK 帶逾時的等待寫法、自架的維運成本。
- DBOS 與 Fastify 並用的方式與限制、實際成熟度、以「天」為單位的長等待。
- 各引擎在 F1 到 F11 的實際表現（完全沒有實測）。

## 下一步

1. 決定資料庫（建議 Postgres；理由是 DBOS 需要，且 little boss 本來就要資料庫）。
2. 建立引擎轉接介面與 F1 到 F11 測試，先接 DBOS，再接 Inngest。
3. 把結果寫回這份文件，選定引擎。

## 來源

- Inngest 定價：https://www.inngest.com/pricing
- Inngest waitForEvent：https://www.inngest.com/docs/reference/functions/step-wait-for-event
- Inngest 服務端點與框架：https://www.inngest.com/docs/learn/serving-inngest-functions
- Inngest 自架：https://www.inngest.com/docs/self-hosting
- Inngest 原始碼與授權：https://github.com/inngest/inngest
- Temporal 定價：https://temporal.io/pricing
- Temporal 訊息傳遞（TypeScript）：https://docs.temporal.io/develop/typescript/message-passing
- Temporal SDK 列表：https://docs.temporal.io/develop
- DBOS Transact（TypeScript）：https://github.com/dbos-inc/dbos-transact-ts
- DBOS 工作流程通訊：https://docs.dbos.dev/typescript/tutorials/workflow-communication
- DBOS 定價：https://www.dbos.dev/pricing
