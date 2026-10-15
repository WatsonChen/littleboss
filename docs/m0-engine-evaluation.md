# M0 引擎評估（草稿，第 2 版）

查證日期：2026-10-15。數字與條款取自各廠商官方頁面（經摘要工具讀取）；付費或承諾前請對照原頁再確認一次。
第三方比較文章只用來找來源，沒有採用其數字。

## 前提

前端與後端都部署在 Vercel，資料庫使用 Neon（Postgres）。這個前提改變了第 1 版的排序。

## 目前建議（2026-10-15，依實測更新）

**先用 Inngest 往下做。** Inngest 在本機開發伺服器上通過全部 18 項契約測試，而且不需要常駐行程，和現有的 Vercel serverless 部署相容。Vercel Workflows 也通過，但它的可用路線（Postgres World）需要常駐主機。
尚未驗證的是 Inngest 託管版（免費額度、在 Vercel 上的簽章驗證）。下面「實測」兩節是依據，其後的「結論（原始規劃）」保留當時的判斷，供對照。

## 結論（原始規劃，尚待實測）

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

## 實測：Vercel Workflows 本機試做（2026-10-15）

在一個獨立的小專案裡試過，版本為 `workflow` 5.2.2、`nitro` 3.0.260903-beta、`fastify` 5.12.7。不需要 Vercel 帳號，用的是 SDK 預設的本機儲存（資料寫在 `.workflow-data/`）。

| 觀察                                         | 結果                                                          |
| -------------------------------------------- | ------------------------------------------------------------- |
| Fastify 能不能用                             | 可以，但需要 Nitro 當建置系統，不是現在的 tsup                |
| 正常流程（步驟、等待 hook、核准、續跑）      | 通過                                                          |
| 等待核准時把伺服器行程強制結束，再重啟後核准 | 通過；步驟 `prepare` 只執行一次，沒有重做（對應 F2 的本機版） |
| 核准早於 hook 登記（run 還沒建立）           | **不會被保留**：`resumeHook` 回 `HookNotFoundError`           |
| 重複核准（run 已完成之後）                   | 也回 `HookNotFoundError`，不是「已處理」                      |

意義：

- 核准一定要先存進我們自己的資料庫，再嘗試 `resumeHook`。早到的核准與重複的核准，都要由資料庫決定結果，不能靠引擎回應。這證實了前面「先查資料庫、登記 hook、再查一次」的規則是必要的。
- 這是本機儲存的結果，**不代表** Vercel 上的行為相同。
- 還有一個 `@workflow/world-postgres` 套件可以把狀態存進 Postgres（文件有列出，未實測）。若可行，狀態就不必留在 Vercel 的儲存，之後搬離 Vercel 也較容易。它與 Neon 連線池的相容性（LISTEN/NOTIFY）**未查證**。
- 步驟必須是頂層、帶 `'use step'` 指令的函式，沒有辦法把閉包當步驟傳進去。這點已處理：`FlowContext.step(ref, input)` 現在只收具名步驟參照與可序列化的輸入（見下一節）。
- 採用 Workflow SDK 代表 `apps/api` 的建置要改成 Nitro；Nitro 3 目前是 beta 版本。這是依賴成熟度的風險。

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

| 案例                                        | 對參考引擎的結果       | 真正引擎：Vercel Workflows（Postgres World）   | 真正引擎：Inngest（開發伺服器）          |
| ------------------------------------------- | ---------------------- | ---------------------------------------------- | ---------------------------------------- |
| F1 重啟續跑（含「外部已寫入但結果未記錄」） | 通過                   | 通過                                           | 通過                                     |
| F2 等待核准時重啟                           | 通過                   | 通過                                           | 通過                                     |
| F3 提前核准                                 | 通過                   | 通過                                           | 通過                                     |
| F4 重複核准                                 | 通過                   | 通過                                           | 通過                                     |
| F5 舊版本核准                               | 通過                   | 通過                                           | 通過                                     |
| F6 取消（等待中、寫入中）                   | 通過                   | 通過                                           | 通過                                     |
| F7 外部成功但回應中斷                       | 通過                   | 通過                                           | 通過                                     |
| F8 重複提交                                 | 通過                   | 通過                                           | 通過                                     |
| F9 設定凍結                                 | 通過                   | 通過                                           | 通過                                     |
| F10 重試上限                                | 通過                   | 通過                                           | 通過                                     |
| F11 長時間等待                              | 通過（以多次重啟模擬） | 通過（以多次重啟模擬；實際睡眠與逾時等待未測） | 通過（100 次重啟；等待逾時要設長，見上） |

測試的有效性：我故意在程式裡植入 5 種錯誤（不記錄步驟結果、忽略取消、設定不凍結、冪等鍵隨機、忽略核准內容雜湊），契約測試都有失敗，表示測得出來。

限制：

- 核准儲存是記憶體版；換成 Neon 後，要再驗證「同時提交只成功一次」。
- F10 目前只涵蓋重試次數上限，「重試不超出預算預留」要等 M1 的預算預留做好後才能測。
- 參考引擎通過，只代表流程寫得對，不代表任何真正的引擎也能通過。

## 實測：Vercel Workflows 轉接器通過全部契約測試（2026-10-15）

位置：`spikes/vercel-workflow/`。同一份 `runEngineContract` 對真正的引擎跑一遍：18 項全部通過（約 227 秒）。流程程式碼與參考引擎共用，沒有為引擎改寫。

| 觀察                                                                | 結果                                                                                                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 預設的本機儲存（Local World）                                       | **崩潰恢復失敗**：佇列在記憶體，重啟後不會重做執行到一半的步驟。F1、F7 這類「步驟中途崩潰」的案例過不了                                                               |
| Postgres World（`@workflow/world-postgres` 5.0.4，graphile-worker） | 全部通過。崩潰的步驟由「備援」機制接手，等待時間由 `WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS` 決定（預設 860 秒，可設 1 到 900）。測試中設為 2 秒                      |
| 流程程式碼的限制                                                    | 工作流沙盒不允許 Node 內建模組（`node:crypto` 等）。流程只能用 `FlowContext` 與「只有名稱的步驟參照」，實作放在 `flow-steps.ts`，用名稱登記。這個切法也適用於 Inngest |
| 第一個步驟                                                          | 在 start 請求裡以 inline 方式執行，崩潰發生在這個請求期間要視為崩潰處理                                                                                               |
| 故意植入的轉接器錯誤                                                | 3 種都被契約測試抓到（測試有效）                                                                                                                                      |

風險與限制：

- **Postgres World 需要常駐行程**（graphile-worker 持續輪詢與執行）。目前 `apps/api` 在 Vercel 以 serverless 函式執行，兩者不相容；要用 Postgres World 就得把 API 放到常駐主機（例如 Fly、Railway、VPS）。這是選引擎時的核心取捨。
- 套件版本不一致：`workflow` 5.2.2 對 `@workflow/world-postgres` 5.0.4。它自稱是參考實作，**工作流的路由沒有驗證**（任何人能打到就能觸發），上線前必須自己加防護。
- 備援恢復的延遲等於租約秒數：把它調得很短會讓慢步驟被重複接手，調得很長則崩潰後要等很久。要搭配步驟的最長執行時間決定。
- **未測**：真正的 Vercel World（部署在 Vercel 上的行為）、Neon 連線（連線池與直連，LISTEN/NOTIFY）、hook 登記時序在真實環境的競爭（F3 在本機通過，不代表雲端也一樣）、長時間睡眠與逾時等待。

## 實測：Inngest 轉接器通過全部契約測試（2026-10-15）

位置：`spikes/inngest/`。用 Inngest 的本機開發伺服器（`inngest-cli` 1.46.0，免費、不用帳號，狀態存在記憶體）和 SDK 4.24.0。開發伺服器是獨立行程，模擬託管服務：測試只殺掉我們的應用程式來模擬崩潰，Inngest 那一側不動。同一份流程程式碼，18 項全部通過（約 190 秒，其中 F11 的 100 次重啟占 140 秒）。

| 觀察           | 結果                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 崩潰中途的步驟 | 應用程式死掉後，Inngest 在下一次重試時重新呼叫；應用程式重啟後就接手。**不需要常駐的背景行程**，這是和 Postgres World 最大的差別 |
| 等待核准       | 等待發生在 Inngest 那一側，等待期間應用程式重啟 100 次也不會重跑任何步驟（F11 通過）                                             |
| 提早核准（F3） | `waitForEvent` 不保留早到的事件。解法與 Vercel 一樣：先查自己的資料庫，再等，等到事件或逾時後再查一次                            |
| 重複啟動       | 事件帶固定 `id`（`start:<runId>`），重送只會產生一個 run                                                                         |
| 取消           | `cancelOn` 依 `data.runId` 比對事件。取消是非同步的：正在執行的步驟會做完，後面的步驟不會跑。測試裡要等 1.5 秒讓取消生效         |
| 步驟重試       | `retries: 2` 即最多 3 次嘗試；重試用盡後，`step.run` 會把錯誤丟回流程，流程可以接住並回報失敗                                    |
| 故意植入的錯誤 | 3 種都被測試抓到：拿掉事件 `id`、拿掉 `cancelOn`、跳過等待前的資料庫檢查                                                         |

風險與限制：

- **應用程式連不上時，重試用盡就會丟掉整個 run。** 把等待逾時調成 5 秒、再做 100 次重啟時，某次逾時剛好落在應用程式關閉的空檔，重試用盡，`inngest/function.failed` 出現，run 永遠停在等待狀態（F11 失敗）。逾時改成 1 小時就通過。正式上線時要：(1) 等待逾時設長；(2) 加失敗處理（`onFailure`）把資料庫裡的 run 標成失敗，或定時對帳。
- 開發伺服器只存在記憶體。託管服務（Inngest Cloud）：**簽章驗證、部署同步、函式執行已在正式環境驗證**（2026-10-15，`ping` 函式 Completed）；免費額度與計價、長時間等待的行為還沒查證。
- Inngest 會重新執行整個函式、用記錄的結果略過已完成的步驟，所以流程程式碼必須是確定性的。目前的流程已經符合（沒有時間、亂數、外部讀取在步驟外）。
- 已經多一個外部服務要依賴；資料（事件與步驟輸出）會經過 Inngest。不要把機密放進步驟輸入或輸出。

### 防護層（2026-10-15）

位置：`spikes/inngest/src/reconcile.ts`、`functions.ts`，測試在 `test/resilience.test.ts`（7 項全過；拿掉 `onFailure` 測試會失敗）。上面「應用程式連不上時，重試用盡就會丟掉整個 run」的風險，用兩道防線處理：

| 防線                  | 負責的情況                                                     | 實測結果                                                                                                              |
| --------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `onFailure`           | 引擎放棄這個 run，而應用程式**還連得上**，例如最後一步連續失敗 | 把資料庫裡的 run 關閉。若外部寫入已經嘗試過，標成 `unknown` 而不是 `failed`（日曆項目可能已存在，只是我們沒記到結果） |
| 定時對帳（每 5 分鐘） | 引擎放棄 run 時**應用程式正好掛掉**                            | 比對我們記錄的進行中 run 與引擎的實際狀態，引擎已結束的就關閉；引擎說還在跑的不動；查不到引擎時不亂關                 |

實測中學到的事：

- **應用程式掛掉時，`onFailure` 救不了。** 引擎放棄 run 後會呼叫 `onFailure` 處理函式，但那時應用程式不在，嘗試約兩次就放棄，不會在應用程式回來後補送。所以對帳是這種情況唯一的保障，`onFailure` 只是更快的捷徑。
- **用「事件」查 run 的 REST 介面會把還在等待的 run 回報成 `Completed`**，導致對帳誤殺健康的 run（測試抓到）。必須先用事件找出 run 編號，再讀每個 run 自己的狀態。
- 事件編號要用引擎回傳的內部編號（送出時回傳的 `ids`），不是我們自己設的 `id`。已在啟動時記錄。
- 對帳有 5 分鐘寬限期：剛送出的事件，引擎可能還沒建立 run，不能馬上判為遺失。
- 託管版查 run 狀態需要 `INNGEST_SIGNING_KEY`（Bearer）。開發伺服器不用。這條路徑在託管環境**還沒測**。
- 引擎放棄的 run 不會自動復活；使用者要重新發起。要不要由對帳自動重送啟動事件（流程對重複執行是安全的，寫入有冪等鍵），留到正式實作時決定。

## 未查證

- Vercel Workflow SDK 是否 GA、授權、能否在非 Vercel 環境執行，以及 hook 的提早 resume 與重複 resume 行為（F3、F4 實測）。
- Temporal 的授權、TypeScript SDK 帶逾時的等待寫法、自架的維運成本。
- DBOS 與 Fastify 並用的方式、在 Vercel 上的恢復行為。
- Neon Free 是否允許商業使用、暫停後的喚醒延遲。
- Vercel Pro 的實際月費（本次沒有查）。
- Temporal、DBOS 在 F1 到 F11 的實際表現（Vercel Workflows 與 Inngest 的開發伺服器已實測，託管版未測）。

## 下一步

1. 資料庫定為 Neon（Postgres）；用連線池連線給應用程式，直連用於遷移。
2. ~~為 Vercel Workflows 與 Inngest 實作 `EngineHarness`~~（已完成，兩者都通過 18 項，見上）。
3. 暫定 Inngest。~~掛上服務端點、接上 Inngest Cloud、驗證簽章~~（已完成，正式環境的 `ping` 函式執行成功）。還要查證：事件與步驟的實際額度與計價。
4. ~~上線前要補的防護~~：等待逾時設 1 小時、`onFailure`、定時對帳（已完成並有測試，見「防護層」）。仍要遵守：事件與步驟輸出不放機密。
5. 補測：Neon 連線（連線池與直連）、託管 Inngest 上的對帳（簽章金鑰查詢）、長時間睡眠與逾時等待。

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
