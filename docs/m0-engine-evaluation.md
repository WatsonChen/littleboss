# M0 引擎評估（草稿，第 2 版）

查證日期：2026-10-15。數字與條款取自各廠商官方頁面（經摘要工具讀取）；付費或承諾前請對照原頁再確認一次。
第三方比較文章只用來找來源，沒有採用其數字。

## 前提

前端與後端都部署在 Vercel，資料庫使用 Neon（Postgres）。這個前提改變了第 1 版的排序。

## 結論（建議，尚待實測）

測試順序：**Vercel Workflows → Inngest → DBOS**。Temporal 為備援；若後端之後改用 C#，它升為首選（只有它有官方 .NET SDK）。
三者共用同一組 F1 到 F11 測試，通過標準不變。

理由：

- Vercel Workflows 跑在同一個平台上，不需要另一個要連得到的服務，官方列出支援 Fastify，Hobby 有免費額度，睡眠與等待沒有時間上限。
- Inngest 同樣適合 Vercel（它呼叫你的 HTTP 端點），不綁平台，是最好的退路。
- DBOS 原本因為「只要 Postgres」排第一，但它設計成長時間執行的行程；在 Vercel 的函式上只能靠排程喚醒的 worker（官方範本就是這樣做），
  而且 Neon 的連線池連線不支援 LISTEN/NOTIFY，需要另開直連。在這個前提下它的優勢變小。
  若之後把後端搬到容器主機（Fly.io、Railway 等，未驗證），可以重新評估。
- 這些都是依文件做的判斷，不是實測結果。

## 已查證的事實

### Vercel Workflows（Workflow SDK）

- 以 `'use workflow'` 與 `'use step'` 寫持久函式；由 Vercel Functions 執行，Vercel Queues 排程，狀態與事件紀錄存在 Vercel 管理的儲存裡。
- 框架支援列表含 Next.js、Vite、Express、Fastify、Hono、Nitro 等；Python 與 NestJS 標為 Beta。
- 睡眠與單次 run 時間沒有上限；每個 run 最多 25,000 個事件、10,000 個步驟；單一步驟的執行時間受 Vercel Functions 上限約束（Hobby 最長 300 秒，Pro 800 秒）。
- Hobby 每月含 50,000 個事件與 1 GB 寫入量。一個正常步驟產生 3 個事件（建立、開始、完成），重試時再加 1 個。
- 狀態保留：Hobby 在 run 結束後只保留 1 天，Pro 7 天。所以呼叫紀錄、上下文快照與核准紀錄必須存在我們自己的資料庫（規格本來就這樣要求）。
- 等待外部資料用 hook：`createHook()` 加 `resumeHook(token, payload)`。文件沒有說明 payload 早於 workflow 等待時到達會不會保留；
  也沒有說明同一個 hook 被重複 resume 會怎樣。文件提醒 token 只負責路由，不驗證呼叫者，路由必須自己驗證身分。
- 帶逾時的等待：把 hook 與 `sleep()` 做 `Promise.race`；文件提醒每次比賽要用同一個 promise，否則可能漏掉事件。
- SDK 版本在多區域功能的說明中出現 `5.0.0-beta.33`，表示 SDK 仍在 beta 版本線。是否正式 GA、授權與能否脫離 Vercel 執行，文件沒說明，**未查證**。
- Vercel 的 Hobby 方案限非商業個人使用；只要部署用於任何人的營利（包含受薪者寫程式），就需要 Pro。小老闆目前是個人使用，若日後商品化就要升級。

### Inngest

- 託管服務為主；你的 app 提供 HTTP 端點（`/api/inngest`）給它呼叫，或用 `connect()` 走 WebSocket。有官方 Fastify 外掛；NestJS 透過 express 轉接。
- Free $0：每月 50k executions（一個 6 步驟的 run 算 7 次，約 7,000 個 run）、5 個並行步驟、事件 256 KiB、單次 run 最長 30 天、追蹤紀錄保留 24 小時。用完後會暫停，不會自動計費。Pro $99/月起。
- 伺服器授權為 SSPL（延遲轉 Apache 2.0）。SDK 語言：TypeScript、Python、Go、Kotlin/Java，沒有 C#。
- 自架：單一執行檔加 SQLite 與記憶體 Redis 可跑；`inngest start` 標為 Beta，不保證支援。
- `step.waitForEvent`：文件沒有說明事件早於等待步驟到達時會不會保留。平行 `waitForEvent` 輸掉的一方不會被取消，會讓 run 停在 Running 直到逾時。

### Temporal

- 需要 Temporal 服務（雲端或自架）加 worker。Cloud 隨用隨付：每百萬 actions $50 起，無月費；試用 $150 額度、90 天。Business 支援加購 $500/月起。
- SDK：TypeScript、.NET、Java、Go、Python、PHP、Ruby、Rust。
- Signal 寫入事件歷史；handler 可在主流程開始前執行，範例暗示提早的 Signal 仍有效，但文件未明講。授權、帶逾時等待的寫法、自架成本：**未查證**。

### DBOS Transact（TypeScript）

- MIT 授權的函式庫；狀態存 Postgres，不需另外的服務。語言：TypeScript、Python、Go、Java；沒有列 C#。選用的管理主控台 Conductor Pro $99/月。
- `send` 成功後保證目的 workflow 能 `recv`；訊息持久存放於 Postgres；從一般程式碼 `send` 要帶 idempotency key。
- 在 Vercel 上的官方範本以排程（cron）喚醒的函式作為 worker，去撈已排隊的 workflow；文件沒有說明函式停止後如何恢復。

### Neon（本專案的資料庫）

- Free：每專案 1 GB 儲存、100 CU 小時；閒置 5 分鐘後暫停（Free 無法關閉）；用完算力會暫停到下個計費期。Launch 方案算力每 CU 小時 $0.106。
- 連線池連線（PgBouncer，交易模式）不支援 LISTEN/NOTIFY、工作階段層級的 advisory lock、`SET`。遷移與需要工作階段狀態的工作要用直連。
- Free 方案是否允許商業使用：頁面沒說明，**未查證**。暫停後第一次查詢的喚醒延遲：**未查證**。

## 對 little boss 的意義

- 核准存在自己的資料庫，不依賴引擎的事件機制（已實作，見 `apps/api/src/core/approval.ts`）。
- 因為 hook 可能在 workflow 登記前就被 resume，核准步驟要用「先查資料庫、登記 hook、再查一次資料庫」的順序，
  否則提交落在兩次查詢之間會讓 run 一直等。這要在 F3 實測，並寫成引擎轉接層的規則。
- 外部寫入一律帶固定的 idempotency key，結果不明時先查證再決定（已實作，見 `external-action.ts`）。
- 引擎的狀態在 Hobby 只留 1 天或 24 小時，所以我們的資料庫才是紀錄的正本。

## 已實作（不依賴任何真正的引擎）

- `core/flow.ts`：引擎中立的流程（提案、等待核准、寫入一次、通知）。流程只透過 `FlowContext` 與引擎互動，副作用都放在 `step` 裡。
- `core/reference-engine.ts`：記憶體版的參考引擎，採用「記錄步驟結果、重啟後重播」的模型，只用來證明流程可以安全重播，**不是正式引擎**。
- `core/engine-contract.ts`：引擎契約測試（F1 到 F11）。要評估真正的引擎，就為它實作 `EngineHarness`，把同一組測試跑一遍。

| 案例                                        | 對參考引擎的結果       | 對真正引擎                             |
| ------------------------------------------- | ---------------------- | -------------------------------------- |
| F1 重啟續跑（含「外部已寫入但結果未記錄」） | 通過                   | 未測                                   |
| F2 等待核准時重啟                           | 通過                   | 未測                                   |
| F3 提前核准                                 | 通過                   | 未測（要驗證登記等待的時序）           |
| F4 重複核准                                 | 通過                   | 未測                                   |
| F5 舊版本核准                               | 通過                   | 未測                                   |
| F6 取消（等待中、寫入中）                   | 通過                   | 未測                                   |
| F7 外部成功但回應中斷                       | 通過                   | 未測                                   |
| F8 重複提交                                 | 通過                   | 未測                                   |
| F9 設定凍結                                 | 通過                   | 未測                                   |
| F10 重試上限                                | 通過                   | 未測                                   |
| F11 長時間等待                              | 通過（以多次重啟模擬） | 未測，且需要用引擎的實際睡眠與等待驗證 |

測試的有效性：我故意在程式裡植入 5 種錯誤（不記錄步驟結果、忽略取消、設定不凍結、冪等鍵隨機、忽略核准內容雜湊），契約測試都有失敗，表示測得出來。

限制：

- 核准儲存是記憶體版；換成 Neon 後，要再驗證「同時提交只成功一次」。
- F10 目前只涵蓋重試次數上限，「重試不超出預算預留」要等 M1 的預算預留做好後才能測。
- 參考引擎通過，只代表流程寫得對，不代表任何真正的引擎也能通過。

## 未查證

- Vercel Workflow SDK 是否 GA、授權、能否在非 Vercel 環境執行，以及 hook 的提早 resume 與重複 resume 行為（F3、F4 實測）。
- Inngest 事件早於等待步驟到達的行為（F3 實測）。
- Temporal 的授權、TypeScript SDK 帶逾時的等待寫法、自架的維運成本。
- DBOS 與 Fastify 並用的方式、在 Vercel 上的恢復行為。
- Neon Free 是否允許商業使用、暫停後的喚醒延遲。
- Vercel Pro 的實際月費（本次沒有查）。
- 各引擎在 F1 到 F11 的實際表現（完全沒有實測）。

## 下一步

1. 資料庫定為 Neon（Postgres）；用連線池連線給應用程式，直連用於遷移。
2. 為 Vercel Workflows 實作 `EngineHarness`，跑同一組契約測試；接著對 Inngest 做同樣的事。
3. 把結果寫回這份文件，選定引擎。

## 來源

- Vercel Workflows：https://vercel.com/docs/workflows
- Vercel Workflows 定價與限制：https://vercel.com/docs/workflows/pricing
- Workflow SDK hooks：https://workflow-sdk.dev/docs/foundations/hooks
- Workflow SDK 入門與框架：https://workflow-sdk.dev/docs/getting-started
- Vercel Functions 時間上限：https://vercel.com/docs/functions/configuring-functions/duration
- Vercel 合理使用與商業使用：https://vercel.com/docs/limits/fair-use-guidelines
- Vercel 的 DBOS 範本：https://vercel.com/templates/next.js/vercel-dbos-integration
- Neon 連線池：https://neon.com/docs/connect/connection-pooling
- Neon 定價：https://neon.com/pricing
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
